// file: GenericEquality.gs
// Issue #312 follow-up: type-erased generic `==` / `!=` over a type parameter
// must use value semantics. Each open type parameter is encoded as
// System.Object, so a raw reference comparison would report equal value types
// as unequal. The emitter dispatches `==` / `!=` over open type parameters
// through System.Object.Equals(object, object), which routes to the boxed
// value's Equals override.

package GSharp.Example.GenericEquality

import System

func Eq[T comparable](a T, b T) bool {
    return a == b
}

func Neq[T comparable](a T, b T) bool {
    return a != b
}

// Value types compare by value, not boxed reference.
Console.WriteLine(Eq[int32](2, 2))
Console.WriteLine(Eq[int32](2, 3))
Console.WriteLine(Neq[int32](2, 3))
Console.WriteLine(Neq[int32](2, 2))
Console.WriteLine(Eq[bool](true, true))

// Reference types keep working.
Console.WriteLine(Eq[string]("ab", "ab"))
Console.WriteLine(Neq[string]("ab", "cd"))
