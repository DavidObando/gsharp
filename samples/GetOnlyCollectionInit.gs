import System
import System.Collections.Generic
import System.Collections.ObjectModel

// Issue #1567: populate a GET-ONLY collection property at construction.
// A braced member initializer `Member: { ... }` inside a composite literal
// lowers to `receiver.Member.Add(...)` on the just-constructed instance,
// exactly like C#'s `new T { Member = { ... } }`. Because it is an Add — not
// an assignment — the property needs no setter.
class Bag {
    prop Items IList[int32] { get; init; }
    prop Names Collection[string] { get; init; }
    prop Lookup IDictionary[string, int32] { get; init; }

    init() {
        Items = List[int32]()
        Names = Collection[string]()
        Lookup = Dictionary[string, int32]()
    }
}

// Empty initializer: no Add calls, the constructed collection stays empty.
var empty = Bag{ Items: {} }
Console.WriteLine(empty.Items.Count)

// Single element.
var one = Bag{ Items: { 42 } }
Console.WriteLine(one.Items.Count)
Console.WriteLine(one.Items[0])

// Many elements across list, collection, and dictionary get-only properties.
// Dictionary entries accept both `"k": v` and `["k"] = v` spellings.
var b = Bag{
    Items: { 10, 20, 30 },
    Names: { "alice", "bob" },
    Lookup: { "a": 1, ["b"] = 2 },
}
Console.WriteLine(b.Items.Count)
Console.WriteLine(b.Items[0])
Console.WriteLine(b.Items[2])
Console.WriteLine(b.Names.Count)
Console.WriteLine(b.Names[0])
Console.WriteLine(b.Names[1])
Console.WriteLine(b.Lookup.Count)
Console.WriteLine(b.Lookup["a"])
Console.WriteLine(b.Lookup["b"])
