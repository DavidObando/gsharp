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
 * Finds the TRX result for a given test key (either a fully-qualified name or the
 * server-provided filter token). TRX `testName` values aren't guaranteed to match the
 * key exactly (e.g. the key may be a partial FQN used with `FullyQualifiedName~`), so
 * an exact match is tried first, then a suffix/substring match in either direction.
 */
export function matchTrxResult(
  key: string,
  results: readonly TrxTestResult[],
): TrxTestResult | undefined {
  const exact = results.find((r) => r.testName === key);
  if (exact) {
    return exact;
  }

  return results.find(
    (r) =>
      r.testName.endsWith(`.${key}`) ||
      key.endsWith(`.${r.testName}`) ||
      r.testName.includes(key) ||
      key.includes(r.testName),
  );
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
