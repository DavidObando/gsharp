// file: LinqExtensions.gs
// Issue #294: BCL/library [Extension] methods are callable with instance
// ("receiver") syntax, e.g. `sequence.Where(pred)`, not only statically as
// `Enumerable.Where(sequence, pred)`. System.Linq.Enumerable extension methods
// over IEnumerable<T> exercise generic type inference from the receiver and
// from the predicate/projection arguments.

package GSharp.Example.LinqExtensions

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

// Single generic extension method, type inferred from the receiver.
var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
for v in evens {
    Console.WriteLine(v)
}

// Chained generic extension methods: Where -> Select.
var doubledEvens = list.Where(func(x int32) bool { return x % 2 == 0 }).Select(func(x int32) int32 { return x * 10 })
for v in doubledEvens {
    Console.WriteLine(v)
}

// Terminal aggregate extension methods.
Console.WriteLine(list.Where(func(x int32) bool { return x > 3 }).Count())
Console.WriteLine(list.Sum())
