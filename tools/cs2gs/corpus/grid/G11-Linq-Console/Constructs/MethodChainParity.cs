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

            // QUARANTINED (CS2GS-GAP): the group-by parity pair was dropped —
            // GroupClause has no canonical G# lowering yet.
            string[] words = { "bb", "a", "ccc", "dd" };
            var queryUpper = from w in words
                             where w.Length >= 2
                             select w.ToUpperInvariant();
            var chainUpper = words.Where(w => w.Length >= 2).Select(w => w.ToUpperInvariant());
            Console.WriteLine($"MethodChainParity: queryUpper={string.Join(",", queryUpper)}");
            Console.WriteLine($"MethodChainParity: chainUpper={string.Join(",", chainUpper)}");
        }
    }
}
