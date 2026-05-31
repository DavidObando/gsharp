// file: GenericExtensionFunctions.gs
// Issue #326: extension functions can declare type parameters. A Go-style
// receiver clause `func (recv R) Name[T](args) ret { ... }` combines the
// extension-function form (Phase 3.B.6 / ADR-0019) with generic type
// parameters (Phase 4.1 / ADR-0020). Type arguments are resolved either by
// inference from the call-site arguments or from an explicit `[T]` list.

package GSharp.Example.GenericExtensionFunctions

import System

// Single type parameter, inferred or explicit.
func (value int32) Echo[T](item T) T {
    return item
}

// The receiver is ignored; the second argument's type is dropped.
func (value int32) PickFirst[T, U](a T, b U) T {
    return a
}

var n = 5

// Inference from the argument type.
Console.WriteLine(n.Echo(42))
Console.WriteLine(n.Echo("hello"))

// Explicit type arguments.
Console.WriteLine(n.Echo[int32](7))
Console.WriteLine(n.Echo[string]("world"))

// Multiple type parameters, inferred.
Console.WriteLine(n.PickFirst(99, "ignored"))
Console.WriteLine(n.PickFirst[string, int32]("kept", 0))
