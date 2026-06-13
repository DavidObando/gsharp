---
title: "Types and values"
sidebar_position: 4
draft: false
---

# Types and values

G# combines Go-like aggregate and collection syntax with CLR type identity. Use the [language specification](/docs/ref/spec#types) for exact syntax.

## Nil and nullable values

`nil` is the null literal. Nullable types are written with `?`, such as `string?`. A non-null value converts to its nullable form, and `nil` converts to nullable types. `null` is not a literal in G#. Use `?:` for null coalescing, `?.` for null-conditional access, and `!!` only when a failed assertion should throw immediately.

If you type the C# spelling `null` in a value position and no symbol named `null` exists in scope, the binder reports `GS0273` ("`'null'` is not a literal in G#. Did you mean `'nil'`?") and recovers by treating the identifier as `nil`, so target-type contexts (`let x string? = null`, `Foo(null)` where `Foo` takes `T?`, `x == null`) continue to typecheck. The diagnostic is suppressed when `null` resolves to a real symbol (a function, local, or field named `null` is legal because `null` is not a keyword). See [ADR-0081](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0081-null-identifier-did-you-mean-nil.md).

This model follows [ADR-0001](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0001-null-model.md).

## Primitive values

The built-in primitive names are explicit and CLR-backed: `bool`, signed and unsigned width-bearing integers, native integers, `float32`, `float64`, `decimal`, `char`, `string`, `object`, and `void`. `object` is the universal upper bound, so values can widen or box to it. See [ADR-0044](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0044-numeric-primitive-coverage.md), [ADR-0045](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0045-object-universal-upper-bound.md), [ADR-0046](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0046-char-literal-grammar.md), and [ADR-0049](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0049-width-bearing-integer-names.md).

Numeric operators are defined for matching primitive types; G# does not silently promote arbitrary mixed numeric operands. Use explicit conversions when crossing type families.

## Arrays, slices, and maps

Arrays have fixed length and are written `[N]T`. Slices are written `[]T` and are backed by CLR arrays in the current implementation. `append` returns a new array-backed value after copying. Maps are written `map[K]V` and are backed by `Dictionary<K,V>`.

```gsharp
let numbers = []int32{1, 2, 3}
let fixed = [3]int32{1, 2, 3}
let names = map[int32]string{1: "one", 2: "two"}
```

Slice design rationale is in [ADR-0016](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0016-slice-storage.md).

## Structs, data classes/structs, and inline structs

Use plain `struct` for value-like aggregates, `data struct` for value-typed records with structural equality and copy/update ergonomics, `data class` for the reference-typed counterpart, and `inline struct` for a single-field value wrapper. The `record` keyword was removed by [ADR-0078](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0078-kotlin-style-type-declaration-grammar.md); migrate to `data struct` (preserves value semantics) or `data class` (reference semantics).

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

Rationale: [ADR-0029](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0029-data-struct-synthesized-members.md), [ADR-0032](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0032-data-struct-ergonomics.md), and [ADR-0033](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0033-inline-value-classes.md).

## Classes and interfaces

Classes are reference-like and support primary constructors, explicit `init` constructors, fields, methods, properties, events, inheritance, and `shared` members. Classes are sealed by default for inheritance unless marked `open`. Methods that can be overridden are marked `open`; overriding methods use `override`. See [ADR-0003](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0003-oo-surface.md) and [ADR-0017](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0017-method-virtuality.md).

Interfaces define method, property, and event signatures. Per ADR-0085 (which supersedes the deferral in ADR-0018) interface methods MAY carry a body — a **default-interface method** (DIM). Classes implementing the interface inherit the default unless they declare their own override.

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

### Static-virtual interface members (ADR-0089)

Interfaces may also expose **static-virtual** members: a `static func` declared inside an interface body. Implementers supply the static via the existing `shared { ... }` block, and generic methods constrained by the interface can dispatch through `T.M(...)`. The implementer's static method is paired to the interface slot via a CLR `MethodImpl` row (ECMA-335 II.22.27); the call site lowers to `constrained. !!T  call <iface>::<method>`. The abstract form is body-less ("static abstract"); the default form ("static virtual") carries a body that implementers may override but don't have to.

```gsharp
sealed interface IAdd {
    static func Add(a int32, b int32) int32         // abstract
    static func Zero() int32 { return 0 }           // default
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

The witness-T parameter `w T` lets the type-argument-inference pipeline pick `T` from the call site; explicit type arguments (`Apply[Plus](3, 4)`) work too. Static-virtual members map directly onto the .NET runtime's "static abstract / static virtual" support (e.g. `INumber<T>`, `IParsable<T>`, `IAdditionOperators<TL, TR, TR>`), so G# generic-math code interoperates with C# 11+ assemblies on either side. Diagnostics `GS0330`–`GS0333` flag the common failure modes (unsupported `static let`, missing implementation, instance method for a static slot, dispatch on the wrong type) — see the [diagnostics reference](../ref/diagnostics.md#static-virtual-interface-member-diagnostics-gs0330gs0333).

### Private interface helper methods (ADR-0090)

Interfaces may also declare `private` helper methods — instance or `private static` — that participate in the interface's own implementation but are NOT part of its public contract. A sibling default method on the same interface may call the helper (via implicit `this` or implicit static-self); implementers cannot see it and cannot override it. The helper carries an IL body on the interface TypeDef with `MethodAttributes.Private | HideBySig` (plus `Static` when combined with ADR-0089's static form) — it is non-virtual and never participates in the v-table.

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

A `private` interface method MUST carry a body (`GS0335` otherwise — abstract private helpers do not make sense because no implementer can supply them). External code calling the helper through an interface receiver triggers `GS0334`. An implementer attempting to declare a same-signature method clashing with the helper triggers `GS0336`. Both modifier orderings parse: `private static func` and `static private func`. See the [diagnostics reference](../ref/diagnostics.md#private-interface-helper-diagnostics-gs0334gs0337) for the full GS0334–GS0337 family.

## Enums

Enums are closed sets of named values. They cannot be generic and must contain at least one member. Equality and switch exhaustiveness diagnostics understand enum members.

```gsharp
enum Status { Pending, Complete, Failed }
```

## Sequences and channels

`sequence[T]` maps to `IEnumerable<T>` and is produced with iterator functions that use `yield`. `async sequence[T]` maps to asynchronous enumeration and is consumed with `await for`. `chan T` represents channels created with `make(chan T)` or `make(chan T, capacity)`.

## Function types and delegates

Function types use the arrow form `(T1, T2, ...) -> R` (ADR-0075). Async function type clauses use `async (T) -> R` and represent task-returning functions (lowered to `(T) -> Task[R]`, or `(T) -> Task` for void). Function values can convert to compatible CLR delegate types, including named delegates and common `Action` or `Func` shapes. The legacy spelling `func(...) R` continues to parse for one release with the `GS0303` deprecation warning.

A **named delegate type** is declared with `type Name = delegate func(...)` (ADR-0059) and emits as a real CLR `MulticastDelegate`-derived type. Named-delegate declarations keep the `func` keyword — only function-*type clauses* moved to the arrow form. Use a named delegate when you want a stable, C#-visible handler type (for example, as the type of a G# `event`):

```gsharp
type Handler = delegate func(sender Object, e EventArgs)

class Button {
    event Click Handler
}
```

## Generics and variance

G# uses bracketed generics: declarations such as `class Box[T any] { ... }` and instantiations such as `Box[int32]`. Type parameters can use `in` and `out` variance markers and named constraints. The implementation supports metadata specs and inference, but some open or partially constructed generic shapes are erased to `object` in emit paths. See [ADR-0004](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0004-generics-scope.md), [ADR-0020](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0020-generic-brackets.md), and [ADR-0021](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0021-generic-variance.md).
