---
title: "Effective G#"
sidebar_position: 1
draft: false
description: "Write clear, idiomatic G# with practical conventions for naming, types, and control flow."
---

# Effective G#

Effective G# favors small packages, explicit data shapes, readable control flow, and direct use of CLR libraries when they are the best tool. This guide is idiomatic advice, not a second specification; use the [language specification](../ref/spec.md) for exact grammar.

## Format code for readers

Keep package declarations and imports at the top, then declarations in dependency order. Prefer complete examples that compile as samples. The smallest program looks like the checked-in `HelloWorld` sample:

```gsharp title="samples/HelloWorld.gs"
package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

```text title="samples/HelloWorld.golden"
Hello, world!
```

## Names and visibility

Use short, descriptive package names and exported surface names that explain domain concepts. G# uses explicit `public`, `internal`, and `private` modifiers where the grammar permits them, with context-specific defaults. Make public APIs intentionally small; keep helper declarations unexported by relying on defaults or `private` when a member belongs only to an implementation.

Prefer width-bearing primitive names such as `int32`, `uint64`, and `float64` in public signatures. They are the canonical built-ins and avoid ambiguity across CLR platforms.

## Naming numeric types

G# accepts ten friendly aliases on top of the canonical width-bearing names: `int` → `int32`, `uint` → `uint32`, `long` → `int64`, `ulong` → `uint64`, `short` → `int16`, `ushort` → `uint16`, `byte` → `uint8`, `sbyte` → `int8`, `float` → `float32`, and `double` → `float64`. The alias resolves to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, `nameof`, hover, and emitted IL always print the canonical name regardless of which spelling you wrote.

Prefer the canonical width-bearing spellings in documentation, public library APIs, and conformance samples — the explicit width keeps cross-library readability stable as a project grows. The friendly aliases are appropriate inside function bodies, lambdas, and local examples where brevity helps reading.

The following declaration is illustrative; its implementation is omitted:

```gsharp
func Encode(values []int32) []uint8 { ... }
```

A counter that changes must use `var`. This complete program is checked in as `samples/WebsiteBindings.gs`:

```gsharp title="bindings.gs"
package Examples.Bindings

import System

let values = []int32{10, 20, 30}
var count int32 = 0
for value in values {
    count++
}
Console.WriteLine(count)
```

```text
3
```

The formatter does not rewrite either spelling — author intent wins. Aliases are reserved type names: `type int = string` (and the equivalent `struct` / `class` / `enum` / `delegate` forms) is rejected with `GS0102` the same way `type int32 = string` already is.

## Choose `let`, `var`, and `const` deliberately

Use `let` when a binding should not be reassigned, `var` when mutation is part of the algorithm, and `const` for compile-time constants. Spell `let name = expr` for a one-line immutable introduction and `var name = expr` when the value is rebound. Use explicit types at API boundaries and for zero-value `var` declarations.

## Prefer simple data declarations

Start with `struct` for value-like aggregates and `class` for identity, mutation, or inheritance. Use `data struct` for value-typed data with structural equality and copy/update behavior. Use `data class` for reference-typed data with structural equality; its data equality is not an identity comparison. A `let` binding does not make the entire referenced object graph immutable.

Use `inline struct` for a single-field value wrapper. Reach for `sealed class` or a payload-bearing `enum` when you need a closed hierarchy with exhaustiveness checking.

```gsharp
data struct Point {
    X int32
    Y int32
}

let origin = Point{X: 0, Y: 0}
let moved = origin with { X = 10 }
```

## Methods, receiver functions, and extension functions

Use class methods when behavior depends on class identity, virtual dispatch, or private representation. Use receiver-style functions for extension behavior — value-oriented helpers on BCL primitives, imported CLR types, types from referenced packages, or even a type this package owns when you deliberately want extension semantics (static dispatch, no interface conformance) rather than a real member. The in-body form is the only spelling for an owned-type instance method; a receiver clause on an owned class, struct, or enum is always an extension, never an instance method.

```gsharp
class Point(X int32, Y int32) {
    func LengthSquared() int32 {
        return X * X + Y * Y
    }
}

// Extension on a type this package does not own:
func (value int32) Abs() int32 {
    if value < 0 { return -value }
    return value
}
```

Use imported CLR extension methods when they fit existing .NET conventions; G# resolves CLR method groups and delegates for interop.

## Error handling

Use CLR exceptions for exceptional failures and let `try`/`catch`/`finally` show the lifetime of recovery logic. Catch the most specific type available. Use `nil` and nullable types for absence, not `null`. When unwrapping a nullable value, prefer explicit checks or `??`; reserve `!!` for places where failure should be immediate and obvious.

```gsharp
try {
    var n = Int32.Parse(text)
    Console.WriteLine(n)
} catch (e FormatException) {
    Console.WriteLine("not a number")
}
```

## Cleanup: `defer` and `using`

Use `using` for disposable resources because the compiler can require a disposable value and place the lifetime directly in the code. Use `defer` for small cleanup calls that should run when the current scope exits. Keep deferred calls simple; the binder requires the deferred operand to be a call.

## Concurrency patterns

For I/O-shaped asynchrony, prefer `async func` and `await`. Use `scope` so child work is joined before the block exits and failures propagate. Use `async sequence[T]` and `await for` when a stream is naturally asynchronous. See [Concurrency and async](./concurrency) for the full surface.

Use `go call(...)` to start a child owned by the surrounding scope; calling two tasks with `.Wait()` one after the other is sequential, not a worker-pool example. See the complete [Tour example](../tour/concurrency.md) and [Trail walkthrough](../tutorials/trail.md) for runnable patterns.

`go`, channels, and `select` are part of the language; they do not require the retired `Gsharp.Extensions.Go` import. See [Go-flavored concurrency](../extensions/go-concurrency.md). Other `Gsharp.Extensions.*` helper namespaces still have their own explicit imports.

## Use CLR interop instead of wrappers when possible

Import CLR namespaces directly, pass function values to delegates, and rely on imported properties, events, constructors, and methods. Write a G# wrapper only when it improves naming, nullability, or generic constraints for G# callers.

## Document implementation differences

Every driver emits CIL, including the interactive REPL. `gsi` accepts only the `emit` engine choice. Add `gsc /out:` when you need to inspect the saved assembly, metadata, or Portable PDB rather than run it immediately.
