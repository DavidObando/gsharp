// inventory: QueryExpression

package Corpus.Grid11

import System
import System.Linq

shared class QueryExpressionFixture {
    func Run() {
        let nums[]int32 = []int32{1, 2, 3, 4}
        // Minimal from + select.
        let doubled = nums.Select((n int32) -> n * 2)
        Console.WriteLine("QueryExpression: doubled=${string.Join(",", doubled)}")
        let words[]string = []string{"ada", "bea", "cid"}
        let shouted = words.Select((w string) -> w.ToUpperInvariant())
        Console.WriteLine("QueryExpression: shouted=${string.Join(",", shouted)}")
    }
}
