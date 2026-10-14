// inventory: TypeArgumentList — nested constructed generics (Dictionary<string, List<int>>)

package Corpus.Grid08

import System
import System.Collections.Generic

shared class TypeArgumentListFixture {
    func Run() {
        let buckets = Dictionary[string, List[int32]]()
        let evens = List[int32]()
        evens.Add(2)
        evens.Add(4)
        buckets["evens"] = evens
        let odds = List[int32]()
        odds.Add(1)
        buckets["odds"] = odds
        Console.WriteLine("TypeArgumentList: evens=" + buckets["evens"].Count.ToString())
        Console.WriteLine("TypeArgumentList: first-even=" + buckets["evens"][0].ToString())
        Console.WriteLine("TypeArgumentList: odds=" + buckets["odds"].Count.ToString())
        Console.WriteLine("TypeArgumentList: keys=" + buckets.Count.ToString())
    }
}
