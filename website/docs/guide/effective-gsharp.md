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

## Choose `let`, `var`, and `const` deliberately

Use `let` when a binding should not be reassigned, `var` when mutation is part of the algorithm, and `const` for compile-time constants. The short `name := expr` form was removed by [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md); spell `let name = expr` for a one-line immutable introduction and `var name = expr` when the value is rebound. Use explicit types at API boundaries and for zero-value `var` declarations.

## Prefer simple data declarations

Start with `struct` for value-like aggregates and `class` for identity, mutation, or inheritance. Use `data struct` when structural equality and copy/update behavior are part of the model. `record` is an alias for `data struct`, so teams should choose one spelling and use it consistently. Use `inline struct` for a single-field value wrapper when you want a domain-specific type without class identity.

```gsharp
type Point data struct {
    X int32
    Y int32
}

let origin = Point{X: 0, Y: 0}
let moved = origin with { X = 10 }
```

Relevant rationale: [ADR-0029](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0029-data-struct-synthesized-members.md), [ADR-0032](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0032-data-struct-ergonomics.md), and [ADR-0033](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0033-inline-value-classes.md).

## Methods, receiver functions, and extension functions

Use class methods when behavior depends on class identity, virtual dispatch, or private representation. Use receiver-style functions for value-oriented behavior and extension-style APIs. ADR-0024 makes this the canonical style: keep data declarations focused and attach behavior with methods or receiver functions where it improves discoverability.

```gsharp
func (p Point) LengthSquared() int32 {
    return p.X * p.X + p.Y * p.Y
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

Rationale: [ADR-0001](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0001-null-model.md) and [ADR-0005](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0005-error-handling.md).

## Cleanup: `defer` and `using`

Use `using` for disposable resources because the compiler can require a disposable value and place the lifetime directly in the code. Use `defer` for small cleanup calls that should run when the current scope exits. Keep deferred calls simple; the binder requires the deferred operand to be a call.

Rationale: [ADR-0030](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0030-defer-and-using-block-scope.md).

## Concurrency patterns

Use channels for ownership transfer and synchronization. Use buffered channels when the capacity is part of the protocol. Use `select` to wait on multiple channel operations. Wrap related `go` calls in `scope` so failures propagate and child tasks are joined before the block exits.

```gsharp
scope {
    go worker(ch)
    ch <- 42
}
```

For I/O-shaped asynchrony, prefer `async func` and `await` over manually coordinating tasks. Use `async sequence[T]` and `await for` when a stream is naturally asynchronous. See [Concurrency and async](/docs/guide/concurrency-async) for details and [ADR-0002](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0002-concurrency-model.md), [ADR-0022](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0022-go-chan-select-lowering.md), and [ADR-0023](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0023-async-state-machine.md).

## Use CLR interop instead of wrappers when possible

Import CLR namespaces directly, pass function values to delegates, and rely on imported properties, events, constructors, and methods. Write a G# wrapper only when it improves naming, nullability, or generic constraints for G# callers.

## Document implementation differences

The interpreter is useful for REPL-style execution and quick feedback, but the emit path is the production path. If a feature depends on metadata emission, async or iterator state machines, Portable PDBs, or byref/pointer interop, verify it with `gsc /out:` or the SDK build path before presenting it as production behavior.
