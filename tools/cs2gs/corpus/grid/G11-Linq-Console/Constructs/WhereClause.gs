// inventory: WhereClause

package Corpus.Grid11

import System
import System.Linq

shared class WhereClauseFixture {
    func Run() {
        let nums[]int32 = []int32{1, 2, 3, 4, 5, 6, 7, 8}
        let evens = nums.Where((n int32) -> n % 2 == 0)
        Console.WriteLine("WhereClause: evens=${string.Join(",", evens)}")
        let band = nums.Where((n int32) -> n > 2 && n < 7)
        Console.WriteLine("WhereClause: band=${string.Join(",", band)}")
        // Two where clauses.
        let picky = nums.Where((n int32) -> n != 4).Where((n int32) -> n % 2 == 0)
        Console.WriteLine("WhereClause: picky=${string.Join(",", picky)}")
    }
}
