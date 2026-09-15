---
title: "Concept quick reference"
description: "Quick answers and important boundaries for G# nullable values, data models, concurrency, and .NET interop."
---

# Concept quick reference

Start with the small answer, then follow the link to the precise rule. Code fragments on this page illustrate an expression or declaration in a larger program; complete runnable programs are linked alongside them.

## Nullable values

`T?` can hold `nil`. `T` and `T?` are distinct types; use nullable flow rather than assuming a value is present.

### Null conditional access

`?.` accesses a member only when its receiver is present:

```gsharp
let length = name?.Length ?? 0
```

Here `name` is a `string?` supplied by the surrounding program. The result is zero when the name is absent.

### Null coalescing

`??` supplies a fallback. `!!` asserts presence and can fail; it is not the safe alternative to a fallback. `if let`, `guard let`, and `while let` introduce non-null bindings in the appropriate region.

Read [nullable control flow](../tour/control-flow.md) or the complete program in [the Kotlin bridge](../bridges/gsharp-for-kotlin-developers.md).

## Data models

| Choice | Use it for |
| --- | --- |
| `struct` | Value-typed aggregates. |
| `class` | Reference-typed objects and their identity or behavior. |
| `data struct` | Value-typed structural data with equality and copy/update. |
| `data class` | Reference-typed structural data with equality and copy/update. |
| `inline struct` | A nominal one-field value wrapper. |

`let` prevents rebinding; it does not recursively freeze a collection or object graph. A counter that changes needs `var`. Copy/update does not imply a deep copy of nested mutable state.

Read [types and values](../guide/types-and-values.md), [binding conventions](../guide/effective-gsharp.md), or build the [data-model tutorial](../tutorials/getting-started.md).

## Concurrency

Start owned child work with `go call(...)` inside `scope`. The scope joins its children and observes failures. Merely constructing an unrelated .NET task inside the block is not a lifetime guarantee.

Channels carry values. `in chan[T]` can receive, `out chan[T]` can send, and `chan[T]` is bidirectional. An empty-capacity channel is a rendezvous; a buffered channel has a bounded number of queued values, not an automatic worker-count limit.

These are language features, not an opt-in `Gsharp.Extensions.Go` namespace. `async func` and `await` provide task-based interoperability, while `async sequence[T]` supports asynchronous iteration.

Read [the concurrency guide](../guide/concurrency.md), [channel operations](../extensions/go-concurrency.md), or the [complete Trail pipeline](../tutorials/trail.md#4-coordinate-a-bounded-worker-pool).

## .NET interop

Import CLR namespaces, reference .NET libraries through your project, and call their members. Generic arguments use brackets, such as `List[int32]`. G# emits ordinary managed assemblies.

The runtime and library contracts still matter: collection mutability, nullable annotations, disposal, exception behavior, and overload resolution do not disappear behind a new syntax.

Read [the interop Tour](../tour/dotnet-interop.md) for examples and [CLR interop](clr-interop.md) for boundaries. Check the [feature matrix](feature-matrix.md) before relying on an advanced capability.

## Find a diagnostic

Search an exact `GSxxxx` code or use the [diagnostics reference](diagnostics.md). Check the documentation version before applying a remedy: retired diagnostics and current diagnostics have different meanings.
