// inventory: QueryExpression
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class QueryExpressionNestedFixture
    {
        public static void Run()
        {
            int[] limits = { 2, 3, 4 };
            int[] pool = { 1, 2, 3, 4, 5 };

            // Nested query inside the select projection. Concatenation (not
            // interpolation) is used because the gsc emitter cannot yet emit
            // InterpolatedStringExpression inside lambda bodies (GS9998).
            var nested = from limit in limits
                         select limit.ToString() + "<=[" + string.Join("|", from p in pool where p <= limit select p) + "]";
            foreach (string line in nested)
            {
                Console.WriteLine($"QueryExpressionNested: {line}");
            }
        }
    }
}
