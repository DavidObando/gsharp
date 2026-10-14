// inventory: ForEachStatement

package Corpus.Grid03.Constructs

import System
import System.Collections.Generic

shared class ForEachStatementFixture {
    func Run() {
        let primes[]int32 = []int32{2, 3, 5, 7, 11}
        var sum = 0
        for p in primes {
            sum += p
        }
        Console.WriteLine("ForEachStatement: sum of first five primes = $sum")
        let names = List[string]()
        names.Add("ada")
        names.Add("bea")
        names.Add("cid")
        for name in names {
            Console.WriteLine("ForEachStatement: name $name")
        }
        let stock = Dictionary[string, int32]()
        stock["pen"] = 4
        stock["ink"] = 9
        stock["pad"] = 2
        let keys = List[string]()
        for key in stock.Keys {
            keys.Add(key)
        }
        keys.Sort()
        for key in keys {
            Console.WriteLine("ForEachStatement: stock[$key] = ${stock[key]}")
        }
    }
}
