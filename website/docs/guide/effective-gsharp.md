---
title: "Effective G#"
sidebar_position: 1
draft: false
---

# Effective G#

Effective G# favors small packages, explicit data shapes, readable control flow, and direct use of CLR libraries when they are the best tool. This guide is idiomatic advice, not a second specification; use the [language specification](/docs/ref/spec) for exact grammar.

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

```gsharp
// Public API: prefer the canonical width-bearing names.
func Encode(values []int32) []uint8 { ... }

// Local code: the friendly aliases are appropriate.
let count int = 0
for x in values {
    count = count + 1
}
```

The formatter does not rewrite either spelling — author intent wins. Aliases are reserved type names: `type int = string` (and the equivalent `struct` / `class` / `enum` / `delegate` forms) is rejected with `GS0102` the same way `type int32 = string` already is.

## Choose `let`, `var`, and `const` deliberately

Use `let` when a binding should not be reassigned, `var` when mutation is part of the algorithm, and `const` for compile-time constants. Spell `let name = expr` for a one-line immutable introduction and `var name = expr` when the value is rebound. Use explicit types at API boundaries and for zero-value `var` declarations.

## Prefer simple data declarations

Start with `struct` for value-like aggregates and `class` for identity, mutation, or inheritance. Use `data struct` when structural equality and copy/update behavior are part of the model (value-typed); use `data class` when reference identity matters. Use `inline struct` for a single-field value wrapper when you want a domain-specific class without identity. Reach for `sealed class` (or a payload-bearing `enum` — a discriminated union) when you need a closed hierarchy with exhaustiveness checking.

```gsharp
data struct Point {
    X int32
    Y int32
}

let origin = Point{X: 0, Y: 0}
let moved = origin with { X = 10 }
```

## Methods, receiver functions, and extension functions

Use class methods when behavior depends on class identity, virtual dispatch, or private representation. Use receiver-style functions for value-oriented behavior on types this package does **not** own (BCL primitives, imported CLR types, types from referenced packages). The in-body form is canonical for owned-type instance methods; a receiver clause that targets an owned class or struct emits the soft `GS0314` warning.

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

Use CLR exceptions for exceptional failures and let `try`/`catch`/`finally` show the lifetime of recovery logic. Catch the most specific type available. Use `nil` and nullable types for absence, not `null`. When unwrapping a nullable value, prefer explicit checks or `?:`; reserve `!!` for places where failure should be immediate and obvious.

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

```gsharp
scope {
    runStage("a").Wait()
    runStage("b").Wait()
}
```

For Go-shaped concurrency primitives — `go`, channels, `select` — see [Extensions: Go-flavored concurrency](../extensions/go-concurrency), which opt in with `import Gsharp.Extensions.Go`.

## Use CLR interop instead of wrappers when possible

Import CLR namespaces directly, pass function values to delegates, and rely on imported properties, events, constructors, and methods. Write a G# wrapper only when it improves naming, nullability, or generic constraints for G# callers.

## Document implementation differences

The interpreter is useful for REPL-style execution and quick feedback, but the emit path is the production path. If a feature depends on metadata emission, async or iterator state machines, Portable PDBs, or byref/pointer interop, verify it with `gsc /out:` or the SDK build path before presenting it as production behavior.
