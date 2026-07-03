// inventory: OrderByClause
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class OrderByClauseFixture
    {
        public static void Run()
        {
            int[] nums = { 5, 1, 4, 2, 3 };

            var asc = from n in nums
                      orderby n
                      select n;
            Console.WriteLine($"OrderByClause: asc={string.Join(",", asc)}");

            var desc = from n in nums
                       orderby n descending
                       select n;
            Console.WriteLine($"OrderByClause: desc={string.Join(",", desc)}");

            // Multi-key: DescendingOrdering then AscendingOrdering.
            (string Name, int Age)[] people =
            {
                ("cid", 30),
                ("ada", 41),
                ("bea", 30),
                ("dee", 41),
            };
            // Concatenation (not interpolation) in the projection: the gsc
            // emitter cannot yet emit InterpolatedStringExpression inside
            // lambda bodies (GS9998).
            var ranked = from p in people
                         orderby p.Age descending, p.Name ascending
                         select p.Name + p.Age.ToString();
            Console.WriteLine($"OrderByClause: ranked={string.Join(",", ranked)}");
        }
    }
}
