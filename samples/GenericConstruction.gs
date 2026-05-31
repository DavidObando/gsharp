import System
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
Console.WriteLine(list.Count)

var counts = Dictionary[string, int32]()
counts["one"] = 1
counts["two"] = 2
Console.WriteLine(counts.Count)

var names = List[string]()
names.Add("alice")
names.Add("bob")
for n in names {
    Console.WriteLine(n)
}

var nested = List[List[int32]]()
var inner = List[int32]()
inner.Add(10)
inner.Add(20)
nested.Add(inner)
Console.WriteLine(nested.Count)
Console.WriteLine(nested[0].Count)

var grouped = Dictionary[string, List[int32]]()
grouped["evens"] = List[int32]()
grouped["evens"].Add(2)
grouped["evens"].Add(4)
Console.WriteLine(grouped["evens"].Count)
