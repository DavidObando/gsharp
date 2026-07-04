// inventory: InvocationExpression
using System;
using System.Linq;

namespace Corpus.Grid11
{
    public static class MethodChainParityFixture
    {
        public static void Run()
        {
            int[] nums = { 5, 1, 4, 2, 3 };

            // Query form and its method-chain equivalent must agree.
            var query = from n in nums
                        where n > 1
                        orderby n descending
                        select n * n;
            var chain = nums.Where(n => n > 1).OrderByDescending(n => n).Select(n => n * n);
            Console.WriteLine($"MethodChainParity: query={string.Join(",", query)}");
            Console.WriteLine($"MethodChainParity: chain={string.Join(",", chain)}");

            // Group-by parity pair (issue #1902 unblocked this — GroupClause now
            // has a canonical G# lowering).
            string[] words = { "bb", "a", "ccc", "dd" };
            var queryGrouped = from w in words
                                group w by w.Length;
            var chainGrouped = words.GroupBy(w => w.Length);
            foreach (var g in queryGrouped)
            {
                Console.WriteLine($"MethodChainParity: queryGrouped len{g.Key}={string.Join(",", g)}");
            }

            foreach (var g in chainGrouped)
            {
                Console.WriteLine($"MethodChainParity: chainGrouped len{g.Key}={string.Join(",", g)}");
            }
        }
    }
}
