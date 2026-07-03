// inventory: QueryContinuation
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class QueryContinuationFixture
    {
        public static void Run()
        {
            // QUARANTINED (CS2GS-GAP): 'group w by w.Length into g' — the
            // GroupClause has no canonical G# lowering yet, so the group-based
            // continuation cannot be exercised. select ... into still can.
            int[] nums = { 1, 2, 3, 4, 5, 6 };
            var scaledUp = from n in nums
                           select n * 10 into scaled
                           where scaled > 20
                           select scaled + 1;
            Console.WriteLine($"QueryContinuation: scaledUp={string.Join(",", scaledUp)}");
        }
    }
}
