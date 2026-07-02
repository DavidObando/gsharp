import { classifyOutcome, matchTrxResult, parseTrx } from '../features/trx';

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
    const match = matchTrxResult('MyApp.Tests.MathTests.Add_ReturnsSum', results);
    expect(match?.outcome).toBe('Passed');
  });

  it('matches a partial filter token against the fully-qualified TRX name', () => {
    const match = matchTrxResult('Divide_ByZero_Throws', results);
    expect(match?.outcome).toBe('Failed');
  });

  it('returns undefined when a requested test has no corresponding TRX entry', () => {
    const match = matchTrxResult('MyApp.Tests.MathTests.Never_Ran', results);
    expect(match).toBeUndefined();
  });
});
