// inventory: CatchFilterClause
// NOTE: a filtered catch with a LATER sibling catch whose type is not provably
// disjoint (e.g. the same exception type) is quarantined: cs2gs reports
// CS2GS-GAP "no faithful G# lowering" (issue #1724). This fixture keeps the
// supported subset: a filtered catch with no overlapping later sibling, where
// a false filter escapes the try (observably identical under rethrow-lowering).
using System;

namespace Corpus.Grid03.Constructs
{
    public static class CatchFilterClauseFixture
    {
        public static void Run()
        {
            for (int code = 1; code <= 2; code++)
            {
                try
                {
                    try
                    {
                        throw new InvalidOperationException($"code-{code}");
                    }
                    catch (InvalidOperationException ex) when (ex.Message == "code-1")
                    {
                        Console.WriteLine($"CatchFilterClause: filter accepted {ex.Message}");
                    }
                }
                catch (InvalidOperationException ex)
                {
                    Console.WriteLine($"CatchFilterClause: filter rejected, outer caught {ex.Message}");
                }
            }
        }
    }
}
