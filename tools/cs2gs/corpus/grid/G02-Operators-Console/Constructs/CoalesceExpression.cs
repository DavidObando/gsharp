// inventory: CoalesceExpression
using System;

namespace Corpus.Grid02
{
    public static class CoalesceExpressionFixture
    {
        public static void Run()
        {
            string? missing = null;
            string? present = "value";
            string first = missing ?? present ?? "last";
            int? none = null;
            int picked = none ?? 21;
            Console.WriteLine($"CoalesceExpression: first={first} picked={picked}");
        }
    }
}
