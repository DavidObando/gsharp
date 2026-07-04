// inventory: QueryContinuation
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class QueryContinuationFixture
    {
        public static void Run()
        {
            int[] nums = { 1, 2, 3, 4, 5, 6 };
            var scaledUp = from n in nums
                           select n * 10 into scaled
                           where scaled > 20
                           select scaled + 1;
            Console.WriteLine($"QueryContinuation: scaledUp={string.Join(",", scaledUp)}");

            // Group-based continuation (issue #1902 unblocked this — GroupClause
            // now has a canonical G# lowering): 'group w by w.Length into g'.
            string[] words = { "one", "two", "three", "four", "six" };
            var longGroups = from w in words
                              group w by w.Length into g
                              where g.Key > 3
                              select $"{g.Key}:{string.Join("|", g)}";
            foreach (string line in longGroups)
            {
                Console.WriteLine($"QueryContinuation: longGroups={line}");
            }
        }
    }
}
