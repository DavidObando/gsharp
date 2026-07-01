import System
import System.Collections.Generic

// Issue #1506: name a nested type of a *constructed* generic type
// (`List[int32].Enumerator`, `Dictionary[string, int32].Enumerator`) in an
// explicit type clause and drive a manual enumeration through it.

var numbers = List[int32]()
numbers.Add(10)
numbers.Add(20)
numbers.Add(30)

var e List[int32].Enumerator = numbers.GetEnumerator()
var sum = 0
while e.MoveNext() {
    sum = sum + e.Current
}
Console.WriteLine(sum)

var counts = Dictionary[string, int32]()
counts["a"] = 1
counts["b"] = 2
var de Dictionary[string, int32].Enumerator = counts.GetEnumerator()
var total = 0
while de.MoveNext() {
    total = total + de.Current.Value
}
Console.WriteLine(total)
