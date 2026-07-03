// inventory: AllowsConstraintClause — `where T : allows ref struct` anti-constraint incl. RefStructConstraint (C#13 probe)
using System;

namespace Corpus.Grid08
{
    public static class SpanFriendly
    {
        public static string Describe<T>(T value)
            where T : allows ref struct
        {
            return "held";
        }
    }

    public static class AllowsConstraintClauseFixture
    {
        public static void Run()
        {
            Console.WriteLine("AllowsConstraintClause: int=" + SpanFriendly.Describe(42));
            Console.WriteLine("AllowsConstraintClause: string=" + SpanFriendly.Describe("text"));
        }
    }
}
