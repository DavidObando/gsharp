namespace Corpus.CompileGap;

/// <summary>
/// A deliberately permanent compile gap. The body translates cleanly to G#
/// (so the translate stage passes) but references an undefined helper, so
/// <c>gsc</c> rejects it with a stable diagnostic regardless of which real
/// compiler gaps are open or closed. This fixture exists solely to exercise
/// the pipeline's triage-artifact + retry-history machinery (ADR-0115 §C),
/// decoupling those tests from the corpus's evolving compile health.
/// </summary>
public static class Residual
{
    /// <summary>Returns a probe value via an intentionally undefined helper.</summary>
    /// <param name="value">An arbitrary input.</param>
    /// <returns>Never compiles; the call target does not exist.</returns>
    public static int Probe(int value)
    {
        return UndefinedTriageHelper(value);
    }
}
