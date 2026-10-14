// inventory: QueryExpression

package Corpus.Grid11

import System
import System.Linq

shared class QueryExpressionNestedFixture {
    func Run() {
        let limits[]int32 = []int32{2, 3, 4}
        let pool[]int32 = []int32{1, 2, 3, 4, 5}
        // Nested query inside the select projection. Concatenation (not
        // interpolation) is used because the gsc emitter cannot yet emit
        // InterpolatedStringExpression inside lambda bodies (GS9998).
        let nested = limits.Select(
            (limit int32) -> limit.ToString() + "<=[" + string.Join("|", pool.Where((p int32) -> p <= limit)) + "]"
        )
        for line in nested {
            Console.WriteLine("QueryExpressionNested: $line")
        }
    }
}
