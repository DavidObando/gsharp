// inventory: InvocationExpression

package Corpus.Grid11

import System
import System.Linq

shared class MethodChainParityFixture {
    func Run() {
        let nums[]int32 = []int32{5, 1, 4, 2, 3}
        // Query form and its method-chain equivalent must agree.
        let query = nums.Where((n int32) -> n > 1).OrderByDescending((n int32) -> n).Select((n int32) -> n * n)
        let chain = nums.Where((n int32) -> n > 1).OrderByDescending((n int32) -> n).Select((n int32) -> n * n)
        Console.WriteLine("MethodChainParity: query=${string.Join(",", query)}")
        Console.WriteLine("MethodChainParity: chain=${string.Join(",", chain)}")
        // Group-by parity pair (issue #1902 unblocked this — GroupClause now
        // has a canonical G# lowering).
        let words[]string = []string{"bb", "a", "ccc", "dd"}
        let queryGrouped = words.GroupBy((w string) -> w.Length)
        let chainGrouped = words.GroupBy((w string) -> w.Length)
        for g in queryGrouped {
            Console.WriteLine("MethodChainParity: queryGrouped len${g.Key}=${string.Join(",", g)}")
        }
        for g in chainGrouped {
            Console.WriteLine("MethodChainParity: chainGrouped len${g.Key}=${string.Join(",", g)}")
        }
    }
}
