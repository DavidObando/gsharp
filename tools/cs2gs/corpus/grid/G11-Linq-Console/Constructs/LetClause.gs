// inventory: LetClause (lowers to Select over a widened tuple scope, issue #1902)

package Corpus.Grid11

import System
import System.Linq

shared class LetClauseFixture {
    func Run() {
        let nums[]int32 = []int32{1, 2, 3, 4, 5}
        let squares = nums
            .Select(
            (n int32) -> {
                return (n, n * n)
            }
        )
            .Where(((n int32, sq int32)) -> sq > 4)
            .Select(((n int32, sq int32)) -> "$n->$sq")
        Console.WriteLine("LetClause: squares=${string.Join(",", squares)}")
        let words[]string = []string{"gnu", "ox", "yak"}
        let tagged = words
            .Select(
            (w string) -> {
                return (w, w.Length)
            }
        )
            .Select(
            ((w string, len int32)) -> {
                return (w, len, w[0])
            }
        )
            .Select(((w string, len int32, head char)) -> "$head$len")
        Console.WriteLine("LetClause: tagged=${string.Join(",", tagged)}")
    }
}
