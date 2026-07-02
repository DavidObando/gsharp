// Minimal, dependency-free parser for the TRX (`--logger trx`) format produced by
// `dotnet test`. Only the handful of fields the Test Explorer needs are extracted;
// the full TRX schema is much larger but not relevant here.

export interface TrxTestResult {
  testName: string;
  outcome: string;
  message?: string;
  stackTrace?: string;
}

export type RunOutcome = 'passed' | 'failed' | 'skipped' | 'errored';

/**
 * Parses the `<UnitTestResult>` entries out of a TRX document's `<Results>` section.
 * Returns an empty array (never throws) for malformed input, so callers can treat "no
 * results" and "unparseable file" the same way: don't silently mark anything as passed.
 */
export function parseTrx(xml: string): TrxTestResult[] {
  const results: TrxTestResult[] = [];
  const resultTagPattern = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;

  let match: RegExpExecArray | null;
  while ((match = resultTagPattern.exec(xml)) !== null) {
    const [, attrs, body] = match;
    const testName = getAttribute(attrs, 'testName');
    const outcome = getAttribute(attrs, 'outcome');
    if (!testName || !outcome) {
      continue;
    }

    const result: TrxTestResult = { testName, outcome };
    if (body) {
      const message = extractTag(body, 'Message');
      const stackTrace = extractTag(body, 'StackTrace');
      if (message) {
        result.message = message;
      }
      if (stackTrace) {
        result.stackTrace = stackTrace;
      }
    }

    results.push(result);
  }

  return results;
}

function getAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Strips the `(arg=value, ...)` parameter list MSTest `[DataRow]`/xUnit `[Theory]`
 * append to a TRX `testName`, leaving the base (non-parameterized) test name so a
 * single TestItem leaf can be matched against every data-driven row it produced.
 */
function baseTestName(testName: string): string {
  const parenIndex = testName.indexOf('(');
  return parenIndex === -1 ? testName : testName.slice(0, parenIndex);
}

/**
 * Finds every TRX result for a given test key (either a fully-qualified name or the
 * server-provided filter token). A single TestItem leaf can map to *multiple* TRX rows
 * when the test is parameterized (`[DataRow]`/`[Theory]`), so this returns all matches
 * rather than just the first — callers must aggregate them (see `aggregateTrxResults`)
 * instead of only looking at one row, or a single failing data row can be hidden behind
 * an earlier passing one.
 *
 * TRX `testName` values aren't guaranteed to match the key exactly (e.g. the key may be
 * a partial FQN used with `FullyQualifiedName~`), so an exact match (ignoring any
 * parameter list) is tried first, then a qualified suffix match in either direction
 * (`Namespace.Class.Add` matches key `Add`, and vice versa). Plain substring matching is
 * intentionally not used: it would let a short name like `Add` spuriously match an
 * unrelated test like `ReadAddress`.
 */
export function matchTrxResults(
  key: string,
  results: readonly TrxTestResult[],
): TrxTestResult[] {
  const keyBase = baseTestName(key);

  const exact = results.filter((r) => {
    const base = baseTestName(r.testName);
    return r.testName === key || base === key || base === keyBase;
  });
  if (exact.length > 0) {
    return exact;
  }

  return results.filter((r) => {
    const base = baseTestName(r.testName);
    return base.endsWith(`.${keyBase}`) || keyBase.endsWith(`.${base}`);
  });
}

/**
 * Maps a raw TRX `outcome` attribute to the coarse-grained bucket the Test Explorer
 * reports through. Unrecognized outcomes (e.g. "Error", "Timeout", "Aborted") are
 * treated as errors rather than silently passing.
 */
export function classifyOutcome(outcome: string): RunOutcome {
  switch (outcome) {
    case 'Passed':
      return 'passed';
    case 'Failed':
      return 'failed';
    case 'NotExecuted':
    case 'Skipped':
    case 'Inconclusive':
    case 'Disconnected':
      return 'skipped';
    default:
      return 'errored';
  }
}

/** The outcome and combined message for a TestItem leaf after aggregating every TRX
 * row that matched it (see `matchTrxResults`). */
export interface AggregatedTrxResult {
  outcome: RunOutcome;
  message?: string;
}

const OUTCOME_PRECEDENCE: RunOutcome[] = ['errored', 'failed', 'passed', 'skipped'];

/**
 * Combines every TRX row matched for a single TestItem leaf into one outcome, using
 * "any failure wins" precedence: if any row errored the leaf is reported as errored,
 * else if any row failed the leaf is failed, else if any row passed the leaf is
 * passed, and only if every row was skipped/not-executed is the leaf skipped. This
 * is what prevents a parameterized test ([DataRow]/[Theory]) with a mix of passing
 * and failing data rows from being reported as passed just because the first row
 * happened to pass. Failure/error messages from every non-passing row are
 * concatenated so no failing data row is silently dropped from the report.
 */
export function aggregateTrxResults(
  results: readonly TrxTestResult[],
): AggregatedTrxResult | undefined {
  if (results.length === 0) {
    return undefined;
  }

  const byOutcome = new Map<RunOutcome, TrxTestResult[]>();
  for (const result of results) {
    const outcome = classifyOutcome(result.outcome);
    const bucket = byOutcome.get(outcome);
    if (bucket) {
      bucket.push(result);
    } else {
      byOutcome.set(outcome, [result]);
    }
  }

  for (const outcome of OUTCOME_PRECEDENCE) {
    const bucket = byOutcome.get(outcome);
    if (!bucket) {
      continue;
    }
    if (outcome === 'passed' || outcome === 'skipped') {
      return { outcome };
    }
    return { outcome, message: formatFailureMessages(bucket) };
  }

  // Unreachable: every classifyOutcome() result is one of OUTCOME_PRECEDENCE.
  return { outcome: 'skipped' };
}

function formatFailureMessages(rows: readonly TrxTestResult[]): string {
  return rows
    .map((row) => {
      const text = row.stackTrace
        ? `${row.message ?? 'Test failed'}\n${row.stackTrace}`
        : (row.message ?? `Test failed: ${row.testName}`);
      return rows.length > 1 ? `[${row.testName}] ${text}` : text;
    })
    .join('\n\n');
}
