// inventory: GroupClause (lowers to GroupBy, issue #1902)

package Corpus.Grid11

import System
import System.Linq

shared class GroupClauseFixture {
    func Run() {
        let nums[]int32 = []int32{1, 2, 3, 4, 5, 6, 7}
        let byMod = nums.GroupBy((n int32) -> n % 3)
        for g in byMod {
            Console.WriteLine("GroupClause: mod${g.Key}=${string.Join(",", g)}")
        }
        let words[]string = []string{"one", "two", "three", "four", "six"}
        let byLen = words.GroupBy((w string) -> w.Length)
        for g in byLen {
            Console.WriteLine("GroupClause: len${g.Key}=${string.Join(",", g)}")
        }
    }
}
