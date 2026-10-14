// inventory: QueryContinuation

package Corpus.Grid11

import System
import System.Linq

shared class QueryContinuationFixture {
    func Run() {
        let nums[]int32 = []int32{1, 2, 3, 4, 5, 6}
        let scaledUp = nums
            .Select((n int32) -> n * 10)
            .Where((scaled int32) -> scaled > 20)
            .Select((scaled int32) -> scaled + 1)
        Console.WriteLine("QueryContinuation: scaledUp=${string.Join(",", scaledUp)}")
        // Group-based continuation (issue #1902 unblocked this — GroupClause
        // now has a canonical G# lowering): 'group w by w.Length into g'.
        let words[]string = []string{"one", "two", "three", "four", "six"}
        let longGroups = words
            .GroupBy((w string) -> w.Length)
            .Where((g IGrouping[int32, string]) -> g.Key > 3)
            .Select((g IGrouping[int32, string]) -> "${g.Key}:${string.Join("|", g)}")
        for line in longGroups {
            Console.WriteLine("QueryContinuation: longGroups=$line")
        }
    }
}
