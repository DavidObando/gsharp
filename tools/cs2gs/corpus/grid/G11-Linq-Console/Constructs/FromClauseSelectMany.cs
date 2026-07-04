// inventory: FromClause (second from, lowers to SelectMany, issue #1902)
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class FromClauseSelectManyFixture
    {
        public static void Run()
        {
            int[] tens = { 10, 20 };
            int[] ones = { 1, 2, 3 };

            // Two from clauses => SelectMany.
            var sums = from t in tens
                       from o in ones
                       select t + o;
            Console.WriteLine($"FromClauseSelectMany: sums={string.Join(",", sums)}");

            string[] words = { "ab", "cd" };
            var chars = from w in words
                        from c in w
                        select c;
            Console.WriteLine($"FromClauseSelectMany: chars={string.Join(",", chars)}");
        }
    }
}
