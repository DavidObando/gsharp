import {
  aggregateTrxResults,
  classifyOutcome,
  matchTrxResults,
  parseTrx,
  TrxTestResult,
} from '../features/trx';

const sampleTrx = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="abc" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="1" testId="1" testName="MyApp.Tests.MathTests.Add_ReturnsSum" outcome="Passed" />
    <UnitTestResult executionId="2" testId="2" testName="MyApp.Tests.MathTests.Divide_ByZero_Throws" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message>Assert.Throws() Failure: expected DivideByZeroException, got none</Message>
          <StackTrace>   at MyApp.Tests.MathTests.Divide_ByZero_Throws() in /src/MathTests.cs:line 42</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult executionId="3" testId="3" testName="MyApp.Tests.MathTests.Skip_NotRun" outcome="NotExecuted" />
  </Results>
</TestRun>`;

describe('parseTrx', () => {
  it('extracts test name, outcome, message and stack trace for every result', () => {
    const results = parseTrx(sampleTrx);
    expect(results).toHaveLength(3);

    expect(results[0]).toEqual({
      testName: 'MyApp.Tests.MathTests.Add_ReturnsSum',
      outcome: 'Passed',
    });

    expect(results[1].testName).toBe('MyApp.Tests.MathTests.Divide_ByZero_Throws');
    expect(results[1].outcome).toBe('Failed');
    expect(results[1].message).toContain('Assert.Throws() Failure');
    expect(results[1].stackTrace).toContain('MathTests.cs:line 42');

    expect(results[2]).toEqual({
      testName: 'MyApp.Tests.MathTests.Skip_NotRun',
      outcome: 'NotExecuted',
    });
  });

  it('returns an empty array for malformed or non-TRX input', () => {
    expect(parseTrx('not xml at all')).toEqual([]);
    expect(parseTrx('')).toEqual([]);
  });

  it('decodes XML entities in attributes and text content', () => {
    const xml = `<Results><UnitTestResult testName="A&amp;B.Test" outcome="Failed"><Output><ErrorInfo><Message>expected &lt;1&gt; but got &quot;2&quot;</Message></ErrorInfo></Output></UnitTestResult></Results>`;
    const [result] = parseTrx(xml);
    expect(result.testName).toBe('A&B.Test');
    expect(result.message).toBe('expected <1> but got "2"');
  });
});

describe('classifyOutcome', () => {
  it('maps known TRX outcomes to run buckets', () => {
    expect(classifyOutcome('Passed')).toBe('passed');
    expect(classifyOutcome('Failed')).toBe('failed');
    expect(classifyOutcome('NotExecuted')).toBe('skipped');
    expect(classifyOutcome('Skipped')).toBe('skipped');
    expect(classifyOutcome('Inconclusive')).toBe('skipped');
  });

  it('treats unrecognized outcomes as errors rather than passes', () => {
    expect(classifyOutcome('Error')).toBe('errored');
    expect(classifyOutcome('Timeout')).toBe('errored');
    expect(classifyOutcome('Aborted')).toBe('errored');
    expect(classifyOutcome('SomeFutureOutcome')).toBe('errored');
  });
});

describe('matchTrxResult', () => {
  const results = parseTrx(sampleTrx);

  it('matches on an exact fully-qualified test name', () => {
    const [match] = matchTrxResults('MyApp.Tests.MathTests.Add_ReturnsSum', results);
    expect(match?.outcome).toBe('Passed');
  });

  it('matches a partial filter token against the fully-qualified TRX name', () => {
    const [match] = matchTrxResults('Divide_ByZero_Throws', results);
    expect(match?.outcome).toBe('Failed');
  });

  it('returns no matches when a requested test has no corresponding TRX entry', () => {
    expect(matchTrxResults('MyApp.Tests.MathTests.Never_Ran', results)).toEqual([]);
  });

  it('does not match a short name as a substring of an unrelated qualified name', () => {
    const xml = `<Results>
      <UnitTestResult testName="MyApp.Tests.AddressTests.ReadAddress" outcome="Passed" />
    </Results>`;
    const rows = parseTrx(xml);
    expect(matchTrxResults('Add', rows)).toEqual([]);
  });

  it('matches a qualified suffix even when the leaf key is short', () => {
    const xml = `<Results>
      <UnitTestResult testName="MyApp.Tests.MathTests.Add" outcome="Passed" />
    </Results>`;
    const rows = parseTrx(xml);
    const matches = matchTrxResults('Add', rows);
    expect(matches).toHaveLength(1);
    expect(matches[0].testName).toBe('MyApp.Tests.MathTests.Add');
  });

  it('matches every parameterized data row against its base (non-parameterized) name', () => {
    const xml = `<Results>
      <UnitTestResult testName="MyApp.Tests.MathTests.Add(a: 1,b: 2)" outcome="Passed" />
      <UnitTestResult testName="MyApp.Tests.MathTests.Add(a: 2,b: 2)" outcome="Failed" />
      <UnitTestResult testName="MyApp.Tests.MathTests.Add(a: 3,b: 2)" outcome="Passed" />
    </Results>`;
    const rows = parseTrx(xml);

    const matches = matchTrxResults('MyApp.Tests.MathTests.Add', rows);
    expect(matches).toHaveLength(3);

    // A short, non-qualified key should also reach every parameterized row via the
    // qualified-suffix match on the base name.
    expect(matchTrxResults('Add', rows)).toHaveLength(3);
  });
});

describe('aggregateTrxResults', () => {
  function row(outcome: string, message?: string): TrxTestResult {
    return { testName: 'MyApp.Tests.MathTests.Add', outcome, message };
  }

  it('returns undefined when there are no matching rows', () => {
    expect(aggregateTrxResults([])).toBeUndefined();
  });

  it('reports passed when every data row passed', () => {
    expect(aggregateTrxResults([row('Passed'), row('Passed')])).toEqual({ outcome: 'passed' });
  });

  it('reports failed if any data row failed, even when an earlier row passed', () => {
    // Regression test for the "any-fail-wins" bug: naive first-match logic (e.g.
    // Array.prototype.find) would return the first (Passed) row here and hide the
    // real failure in the second row.
    const aggregated = aggregateTrxResults([row('Passed'), row('Failed', 'boom')]);
    expect(aggregated?.outcome).toBe('failed');
    expect(aggregated?.message).toContain('boom');
  });

  it('reports passed when a row passed and another was merely not executed', () => {
    expect(aggregateTrxResults([row('Passed'), row('NotExecuted')])).toEqual({
      outcome: 'passed',
    });
  });

  it('reports errored when any row errored, even alongside a failed row', () => {
    const aggregated = aggregateTrxResults([row('Failed', 'assertion failed'), row('Error', 'boom')]);
    expect(aggregated?.outcome).toBe('errored');
    expect(aggregated?.message).toContain('boom');
  });

  it('reports skipped only when every row was skipped/not executed', () => {
    expect(aggregateTrxResults([row('NotExecuted'), row('Skipped')])).toEqual({
      outcome: 'skipped',
    });
  });
});
