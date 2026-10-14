// inventory: FromClause (second from, lowers to SelectMany, issue #1902)

package Corpus.Grid11

import System
import System.Linq

shared class FromClauseSelectManyFixture {
    func Run() {
        let tens[]int32 = []int32{10, 20}
        let ones[]int32 = []int32{1, 2, 3}
        // Two from clauses => SelectMany.
        let sums = tens.SelectMany(
            (t int32) -> ones,
            (t int32, o int32) -> {
                return (t, o)
            }
        )
            .Select(((t int32, o int32)) -> t + o)
        Console.WriteLine("FromClauseSelectMany: sums=${string.Join(",", sums)}")
        let words[]string = []string{"ab", "cd"}
        let chars = words.SelectMany(
            (w string) -> w,
            (w string, c char) -> {
                return (w, c)
            }
        )
            .Select(((w string, c char)) -> c)
        Console.WriteLine("FromClauseSelectMany: chars=${string.Join(",", chars)}")
    }
}
