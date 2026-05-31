// file: OptionalExtensionArgs.gs
// Issue #327: imported [Extension] methods with trailing optional/default
// parameters are callable while omitting those arguments. Mirrors
// HttpResponse.WriteAsync(text) — whose string-only overload has a
// `CancellationToken cancellationToken = default` trailing parameter — using
// the dependency-free System.Linq.Enumerable.CountBy<TSource,TKey>(
//   this IEnumerable<TSource> source,
//   Func<TSource,TKey> keySelector,
//   IEqualityComparer<TKey> comparer = null)
// extension, called with only the key selector (the optional comparer omitted).

package GSharp.Example.OptionalExtensionArgs

import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)
list.Add(5)
list.Add(6)

// CountBy groups by the key selector; the optional comparer argument is
// omitted, so it must resolve to the trailing-optional overload.
var counts = list.CountBy(func(x int32) int32 { return x % 2 })
for kv in counts {
    Console.WriteLine(kv.Key)
    Console.WriteLine(kv.Value)
}
