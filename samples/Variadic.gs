// file: Variadic.gs
// ADR-0101 / issue #799 — demonstrates user-declared variadic
// parameters using the canonical G# spelling `name ...T`. The body
// sees the parameter as a `[]T` slice; the call site can either pass
// N positional arguments (packed into a fresh `[]T`) or a single
// `[]T` value (which passes through as-is, preserving identity).

package GSharp.Example.Variadic

import System

func sum(nums ...int32) int32 {
    var total = 0
    for v in nums {
        total = total + v
    }
    return total
}

func Of[T](values ...T) []T {
    return values
}

Console.WriteLine(sum(1, 2, 3, 4, 5))
Console.WriteLine(sum())

let arr = []int32{10, 20, 30}
Console.WriteLine(sum(arr))

let xs = Of(7, 8, 9)
Console.WriteLine(xs.Length)
Console.WriteLine(xs[0])
Console.WriteLine(xs[2])

let ys = Of(arr)
Console.WriteLine(ys.Length)
