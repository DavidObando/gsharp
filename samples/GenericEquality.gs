// file: GenericEquality.gs
// Issue #312 follow-up: generic `==` / `!=` over a type parameter must use
// value semantics. Under the reified emit (ADR-0087 R1–R7) generic methods
// carry their own `MVar` slots, so `a == b` over `T` lowers through the
// constraint-driven equality path rather than the previous boxed
// `Object.Equals(object, object)` route. Value types compare by value;
// reference types keep working through the normal reference path.

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
