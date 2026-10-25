// file: AllowsRefStruct.gs
//
// Issue #5216: an imported generic parameter that declares `allows ref struct`
// (the CLR `AllowByRefLike` flag) accepts a by-ref-like type argument such as
// `ReadOnlySpan[char]`. This sample uses the .NET 9 alternate-lookup APIs, the
// `Action` and `Func` delegates, `Unsafe.AreSame`, and a custom
// `IAlternateEqualityComparer`. A parameter without the flag, such as the one
// of `List[T]`, still rejects the argument.

package GSharp.Samples.AllowsRefStruct

import System
import System.Collections.Generic
import System.Runtime.CompilerServices
import System.Threading.Tasks

class SpanComparer : IEqualityComparer[string], IAlternateEqualityComparer[ReadOnlySpan[char], string] {
    func Equals(a string?, b string?) bool -> string.Equals(a, b)

    func GetHashCode(s string) int32 -> s.GetHashCode()

    func Equals(alt ReadOnlySpan[char], s string) bool -> alt.SequenceEqual(s.AsSpan())

    func GetHashCode(alt ReadOnlySpan[char]) int32 -> alt.ToString().GetHashCode()

    func Create(alt ReadOnlySpan[char]) string -> alt.ToString()
}

class LookupHolder {
    var lookup Dictionary[string, int32].AlternateLookup[ReadOnlySpan[char]]
}

func makeLookup() Dictionary[string, int32].AlternateLookup[ReadOnlySpan[char]] {
    let d = Dictionary[string, int32]()
    d["k"] = 7
    return d.GetAlternateLookup[ReadOnlySpan[char]]()
}

func numbers(d Dictionary[string, int32]) IEnumerable[int32] {
    let lookup = d.GetAlternateLookup[ReadOnlySpan[char]]()
    yield lookup["a".AsSpan()]
    yield lookup["a".AsSpan()] + 1
}

async func later(d Dictionary[string, int32]) Task[int32] {
    let lookup = d.GetAlternateLookup[ReadOnlySpan[char]]()
    await Task.Yield()
    return lookup["a".AsSpan()]
}

func useAction(a Action[ReadOnlySpan[char]]) {
    a("hello".AsSpan())
}

func main() {
    let d = Dictionary[string, int32]()
    d["a"] = 1
    d["bcd"] = 2
    let lookup = d.GetAlternateLookup[ReadOnlySpan[char]]()
    let key = "xbcdy".AsSpan(1, 3)
    Console.WriteLine(lookup[key])
    Console.WriteLine(lookup.ContainsKey(key))
    var found int32 = 0
    Console.WriteLine(lookup.TryGetValue("a".AsSpan(), out found))
    Console.WriteLine(found)
    lookup[key] = 22
    Console.WriteLine(d["bcd"])

    let set = HashSet[string]()
    set.Add("q")
    Console.WriteLine(set.GetAlternateLookup[ReadOnlySpan[char]]().Contains("q".AsSpan()))

    var typed Dictionary[string, int32].AlternateLookup[ReadOnlySpan[char]] = d.GetAlternateLookup[ReadOnlySpan[char]]()
    Console.WriteLine(typed["a".AsSpan()])
    Console.WriteLine(d.TryGetAlternateLookup[ReadOnlySpan[char]](out var tried))
    Console.WriteLine(tried["a".AsSpan()])

    let stored = makeLookup()
    let viaClosure Func[string, int32] = (s string) -> stored[s.AsSpan()]
    Console.WriteLine(viaClosure("k"))
    let holder = LookupHolder()
    holder.lookup = stored
    Console.WriteLine(holder.lookup["k".AsSpan()])

    for x in numbers(d) {
        Console.WriteLine(x)
    }
    Console.WriteLine(later(d).Result)

    var first = "abc".AsSpan()
    var second = "abc".AsSpan()
    Console.WriteLine(Unsafe.AreSame(ref first, ref first))
    Console.WriteLine(Unsafe.AreSame(ref first, ref second))
    Console.WriteLine(Unsafe.SizeOf[ReadOnlySpan[char]]() > 0)

    let length Func[ReadOnlySpan[char], int32] = (s ReadOnlySpan[char]) -> s.Length
    Console.WriteLine(length("four".AsSpan()))
    useAction((s ReadOnlySpan[char]) -> Console.WriteLine(s.Length))

    let custom = Dictionary[string, int32](SpanComparer())
    custom["abc"] = 3
    Console.WriteLine(custom.GetAlternateLookup[ReadOnlySpan[char]]()["zabcz".AsSpan(1, 3)])
}
main()
