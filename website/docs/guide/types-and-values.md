---
title: "Types and values"
sidebar_position: 4
draft: false
---

# Types and values

G# combines concise aggregate and collection syntax with CLR type identity. Use the [language specification](/docs/ref/spec#types) for exact syntax.

## Nil and nullable values

`nil` is the null literal. Nullable types are written with `?`, such as `string?`. A non-null value converts to its nullable form, and `nil` converts to nullable types. `null` is not a literal in G#. Use `?:` for null coalescing, `?.` for null-conditional access, and `!!` only when a failed assertion should throw immediately.

If you type the C# spelling `null` in a value position and no symbol named `null` exists in scope, the binder reports `GS0273` ("`'null'` is not a literal in G#. Did you mean `'nil'`?") and recovers by treating the identifier as `nil`, so target-type contexts (`let x string? = null`, `Foo(null)` where `Foo` takes `T?`, `x == null`) continue to typecheck. The diagnostic is suppressed when `null` resolves to a real symbol (a function, local, or field named `null` is legal because `null` is not a keyword).

## Primitive values

The built-in primitive names are explicit and CLR-backed: `bool`, signed and unsigned width-bearing integers, native integers, `float32`, `float64`, `decimal`, `char`, `string`, `object`, and `void`. `object` is the universal upper bound, so values can widen or box to it. Friendly numeric aliases (`int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, `double`) are accepted everywhere a type name is accepted and resolve to the canonical width-bearing names at the binder; the canonical names remain the preferred spelling for documentation and public library APIs.

Numeric operators are defined for matching primitive types; G# does not silently promote arbitrary mixed numeric operands. Use explicit conversions when crossing type families.

## Arrays, slices, and maps

Arrays have fixed length and are written `[N]T`. Slices are written `[]T` and are backed by CLR arrays in the current implementation. Use `.Length` for slice and array length, and use CLR collection types such as `List[T]` when you need growable storage. Maps are written `map[K,V]` and are backed by `Dictionary<K,V>`.

```gsharp
let numbers = []int32{1, 2, 3}
let fixed = [3]int32{1, 2, 3}
let names = map[int32,string]{1: "one", 2: "two"}
```


## Structs, data classes/structs, and inline structs

Use plain `struct` for value-like aggregates, `data struct` for value-typed structural aggregates with equality and copy/update ergonomics, `data class` for the reference-typed counterpart, and `inline struct` for a single-field value wrapper.

```gsharp title="samples/DataStruct.gs"
package GSharp.Example.DataStruct

import System

data struct Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = Point{X: 3, Y: 4}
Console.WriteLine(p == q)
```


## Classes and interfaces

Classes are reference-like and support primary constructors, explicit `init` constructors, fields, methods, properties, events, inheritance, and `shared` members. Classes are sealed by default for inheritance unless marked `open`. Methods that can be overridden are marked `open`; overriding methods use `override`. 
Interfaces define method, property, and event signatures. Interface methods may carry a body — a **default-interface method** (DIM). Classes implementing the interface inherit the default unless they declare their own override.

```gsharp
interface IGreeter {
    func Hello() string { return "hi (default)" }
    func Required(name string) string
}

class Quiet : IGreeter {
    func Required(name string) string { return "(quiet) $name" }
}

class Loud : IGreeter {
    func Hello() string { return "LOUD" }
    func Required(name string) string { return "(loud) $name" }
}
```

`Quiet` inherits `Hello`; `Loud` overrides it. Dispatch through either a class-typed or interface-typed receiver lands on the correct body. When two unrelated interfaces both supply a default for the same signature, the implementing class MUST declare its own override — the binder reports `GS0318` ("conflicting default implementations") otherwise. The deferred-modifier diagnostic `GS0321` covers private and `sealed override` interface members, which are reserved for follow-up work.

### Static-virtual interface members

Interfaces may also expose **static-virtual** members. Per the issue #865 revision of ADR-0089 these members live inside a `shared { … }` block on the interface — the same `shared { … }` block that hosts static members on classes and structs (ADR-0053). A body-less `func` inside that block is an abstract static-virtual slot ("static abstract"); a `func` with a body is a default static-virtual member ("static virtual") that implementers may override but don't have to. Implementers supply the static via their own `shared { … }` block, and generic methods constrained by the interface can dispatch through `T.M(...)`. The implementer's static method is paired to the interface slot via a CLR `MethodImpl` row (ECMA-335 II.22.27); the call site lowers to `constrained. !!T  call <iface>::<method>`.

```gsharp
sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32            // abstract
        func Zero() int32 { return 0 }              // default
    }
}

class Plus : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}

func Apply[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Console.WriteLine(Apply(Plus{}, 3, 4))              // 7
```

The witness-T parameter `w T` lets the type-argument-inference pipeline pick `T` from the call site; explicit type arguments (`Apply[Plus](3, 4)`) work too. Static-virtual members map directly onto the .NET runtime's "static abstract / static virtual" support (e.g. `INumber<T>`, `IParsable<T>`, `IAdditionOperators<TL, TR, TR>`), so G# generic-math code interoperates with C# 11+ assemblies on either side. Diagnostics `GS0330`–`GS0333` flag the common failure modes (a non-`func` member inside the interface's `shared { }` block, missing implementation, instance method for a static slot, dispatch on the wrong type) — see the [diagnostics reference](../ref/diagnostics.md#static-virtual-interface-member-diagnostics-gs0330gs0333).

### Private interface helper methods

Interfaces may also declare `private` helper methods that participate in the interface's own implementation but are NOT part of its public contract. **Instance** helpers are written as `private func` directly inside the interface body; **static** helpers are written as `private func` inside the interface's `shared { … }` block (per the issue #865 revision of ADR-0089/0090). A sibling default method on the same interface may call the helper (via implicit `this` or implicit static-self); implementers cannot see it and cannot override it. The helper carries an IL body on the interface TypeDef with `MethodAttributes.Private | HideBySig` (plus `Static` when declared inside the `shared { … }` block) — it is non-virtual and never participates in the v-table.

```gsharp
interface ICalculator {
    func Double(x int32) int32 { return Helper(x) + Helper(x) }
    func Triple(x int32) int32 { return Helper(x) + Helper(x) + Helper(x) }

    // Visible only to sibling default methods on ICalculator.
    private func Helper(x int32) int32 { return x }
}

class Calc : ICalculator {
}                       // inherits Double / Triple; cannot see Helper

var c = Calc{}
Console.WriteLine(c.Double(5))    // 10
Console.WriteLine(c.Triple(5))    // 15
```

A `private` interface method MUST carry a body (`GS0335` otherwise — abstract private helpers do not make sense because no implementer can supply them). External code calling the helper through an interface receiver triggers `GS0334`. An implementer attempting to declare a same-signature method clashing with the helper triggers `GS0336`. Static private helpers are written as `private func` inside the interface's `shared { … }` block (the same block that hosts static-virtual members per ADR-0089). See the [diagnostics reference](../ref/diagnostics.md#private-interface-helper-diagnostics-gs0334gs0337) for the full GS0334–GS0337 family.

### Explicit-base interface calls

When two unrelated interfaces both supply a default body for the same signature, the implementing class must declare its own override and choose. The **explicit-base interface call** syntax lets the override delegate to one — or both — of the inherited defaults via `base[IFoo].Method(args)`. The emit shape is a non-virtual `call instance R IFoo::Method(...)` so the inherited body is invoked directly rather than re-dispatched through the v-table (which would re-enter the override and recurse).

```gsharp
interface ILeft {
    func Tag() string { return "L" }
}

interface IRight {
    func Tag() string { return "R" }
}

class Combined : ILeft, IRight {
    func Tag() string {
        // Diamond disambiguation: combine both inherited defaults.
        return base[ILeft].Tag() + base[IRight].Tag()
    }
}
```

`base[IFoo]` may be used inside any instance member of a class that implements `IFoo` — including private members and non-conflicting overrides ("default + extra logic"). Private interface helpers remain unreachable across the implementer / interface boundary by design (`GS0341`). The full GS0338–GS0341 diagnostic family is documented in the [diagnostics reference](../ref/diagnostics.md#explicit-base-interface-call-diagnostics-gs0338gs0341).

## Enums

Enums are closed sets of named values. They cannot be generic and must contain at least one member. Equality and switch exhaustiveness diagnostics understand enum members.

```gsharp
enum Status { Pending, Complete, Failed }
```

## Sequences and channels

`sequence[T]` maps to `IEnumerable<T>` and is produced with iterator functions that use `yield`. `async sequence[T]` maps to asynchronous enumeration and is consumed with `await for`. `chan T` represents channels created with `make(chan T)` or `make(chan T, capacity)`.

## Function types and delegates

Function types use the arrow form `(T1, T2, ...) -> R`. Async function type clauses use `async (T) -> R` and represent task-returning functions (lowered to `(T) -> Task[R]`, or `(T) -> Task` for void). Function values can convert to compatible CLR delegate types, including named delegates and common `Action` or `Func` shapes.

A **named delegate type** is declared with `type Name = delegate func(...)` and emits as a real CLR `MulticastDelegate`-derived type. Named-delegate declarations keep the `func` keyword — only function-*type clauses* moved to the arrow form. Use a named delegate when you want a stable, C#-visible handler type (for example, as the type of a G# `event`):

```gsharp
type Handler = delegate func(sender Object, e EventArgs)

class Button {
    event Click Handler
}
```

## Generics and variance

G# uses bracketed generics: declarations such as `class Box[T any] { ... }` and instantiations such as `Box[int32]`. Type parameters can use `in` and `out` variance markers and named constraints. The implementation supports metadata specs and inference, but some open or partially constructed generic shapes are erased to `object` in emit paths. 