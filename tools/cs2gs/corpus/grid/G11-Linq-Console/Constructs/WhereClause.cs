// inventory: WhereClause
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class WhereClauseFixture
    {
        public static void Run()
        {
            int[] nums = { 1, 2, 3, 4, 5, 6, 7, 8 };

            var evens = from n in nums
                        where n % 2 == 0
                        select n;
            Console.WriteLine($"WhereClause: evens={string.Join(",", evens)}");

            var band = from n in nums
                       where n > 2 && n < 7
                       select n;
            Console.WriteLine($"WhereClause: band={string.Join(",", band)}");

            // Two where clauses.
            var picky = from n in nums
                        where n != 4
                        where n % 2 == 0
                        select n;
            Console.WriteLine($"WhereClause: picky={string.Join(",", picky)}");
        }
    }
}
