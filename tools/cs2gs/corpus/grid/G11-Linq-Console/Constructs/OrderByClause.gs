// inventory: OrderByClause

package Corpus.Grid11

import System
import System.Linq

shared class OrderByClauseFixture {
    func Run() {
        let nums[]int32 = []int32{5, 1, 4, 2, 3}
        let asc = nums.OrderBy((n int32) -> n)
        Console.WriteLine("OrderByClause: asc=${string.Join(",", asc)}")
        let desc = nums.OrderByDescending((n int32) -> n)
        Console.WriteLine("OrderByClause: desc=${string.Join(",", desc)}")
        // Multi-key: DescendingOrdering then AscendingOrdering.
        let people[](Name string, Age int32) = [](Name string, Age int32){
            ("cid", 30),
            ("ada", 41),
            ("bea", 30),
            ("dee", 41)
        }
        // Concatenation (not interpolation) in the projection: the gsc
        // emitter cannot yet emit InterpolatedStringExpression inside
        // lambda bodies (GS9998).
        let ranked = people
            .OrderByDescending((p(Name string, Age int32)) -> p.Age)
            .ThenBy((p(Name string, Age int32)) -> p.Name)
            .Select((p(Name string, Age int32)) -> p.Name + p.Age.ToString())
        Console.WriteLine("OrderByClause: ranked=${string.Join(",", ranked)}")
    }
}
