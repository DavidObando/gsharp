// file: ForInIEnumerable.gs
// Issue #538 (fixed): `for x in y` over an IReadOnlyList[T] / IEnumerable[T]
// CLR sequence must lower through the GetEnumerator/MoveNext/Current pattern.

package GSharp.Refactoring.ForInIEnumerable

import System
import System.Collections.Generic

func makeList() IReadOnlyList[int32] {
    let xs = List[int32]()
    xs.Add(10)
    xs.Add(20)
    xs.Add(30)
    return xs
}

for v in makeList() {
    Console.WriteLine(v)
}
