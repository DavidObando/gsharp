// inventory: QueryExpression
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class QueryExpressionFixture
    {
        public static void Run()
        {
            int[] nums = { 1, 2, 3, 4 };

            // Minimal from + select.
            var doubled = from n in nums
                          select n * 2;
            Console.WriteLine($"QueryExpression: doubled={string.Join(",", doubled)}");

            string[] words = { "ada", "bea", "cid" };
            var shouted = from w in words
                          select w.ToUpperInvariant();
            Console.WriteLine($"QueryExpression: shouted={string.Join(",", shouted)}");
        }
    }
}
