// file: GenericMethodDelegates.gs
// Issue #312 follow-up: a method (or free) type parameter used as a generic
// argument of a delegate type — e.g. `func Map[TResult](f (TItem) -> TResult)`
// — now binds and emits. The type-erased generic model encodes the open
// delegate as System.Func<object, object> and invokes it through
// System.Delegate.DynamicInvoke so value-type arguments and returns round-trip
// correctly across the erased boundary.

package GSharp.Example.GenericMethodDelegates

import System

// A generic class whose generic method takes a delegate parameterized by both
// the class's type parameter (`TItem`) and the method's own (`TResult`).
class Box[TItem] {
    var Value TItem

    func Map[TResult](f (TItem) -> TResult) TResult {
        return f(this.Value)
    }

    func Fold[TAcc](seed TAcc, f (TAcc, TItem) -> TAcc) TAcc {
        return f(seed, this.Value)
    }
}

// A free generic function with a delegate parameter over its type parameters.
func Apply[T, U](x T, f (T) -> U) U {
    return f(x)
}

var b = Box[int32]{Value: 21}

// Value-type argument and value-type return through the open delegate.
Console.WriteLine(b.Map[int32](func(x int32) int32 { return x + x }))

// Reference-type return through the open delegate.
Console.WriteLine(b.Map[string](func(x int32) string { return "mapped" }))

// Multiple delegate parameters mixing the class and method type parameters.
Console.WriteLine(b.Fold[int32](100, func(acc int32, x int32) int32 { return acc + x }))

// Reference-type element type.
var s = Box[string]{Value: "hi"}
Console.WriteLine(s.Map[string](func(t string) string { return t + t }))

// Free generic function: inferred-from-explicit type args, value and bool.
Console.WriteLine(Apply[int32, int32](10, func(x int32) int32 { return x * 3 }))
Console.WriteLine(Apply[int32, bool](5, func(x int32) bool { return x > 3 }))
