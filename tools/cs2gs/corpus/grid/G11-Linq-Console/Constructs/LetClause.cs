// inventory: LetClause (lowers to Select over a widened tuple scope, issue #1902)
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class LetClauseFixture
    {
        public static void Run()
        {
            int[] nums = { 1, 2, 3, 4, 5 };

            var squares = from n in nums
                          let sq = n * n
                          where sq > 4
                          select $"{n}->{sq}";
            Console.WriteLine($"LetClause: squares={string.Join(",", squares)}");

            string[] words = { "gnu", "ox", "yak" };
            var tagged = from w in words
                         let len = w.Length
                         let head = w[0]
                         select $"{head}{len}";
            Console.WriteLine($"LetClause: tagged={string.Join(",", tagged)}");
        }
    }
}
