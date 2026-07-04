// inventory: GroupClause (lowers to GroupBy, issue #1902)
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class GroupClauseFixture
    {
        public static void Run()
        {
            int[] nums = { 1, 2, 3, 4, 5, 6, 7 };

            var byMod = from n in nums
                        group n by n % 3;
            foreach (var g in byMod)
            {
                Console.WriteLine($"GroupClause: mod{g.Key}={string.Join(",", g)}");
            }

            string[] words = { "one", "two", "three", "four", "six" };
            var byLen = from w in words
                        group w by w.Length;
            foreach (var g in byLen)
            {
                Console.WriteLine($"GroupClause: len{g.Key}={string.Join(",", g)}");
            }
        }
    }
}
