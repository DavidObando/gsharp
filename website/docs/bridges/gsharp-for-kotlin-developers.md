---
title: "G# for Kotlin developers"
description: "Bring your Kotlin experience to G#: compare data classes, nullable values, functions, collections, and structured concurrency on .NET."
sidebar_position: 3
---

# G# for Kotlin developers

G# will look familiar in places: data classes, nullable types, explicit read-only bindings, and structured work. The biggest change is the platform. G# produces .NET assemblies and uses .NET libraries and tooling; it is not a Kotlin compatibility layer and does not run JVM libraries directly.

Start with [installation](../getting-started/install.md), then use this guide to translate concepts rather than mechanically translating source.

## The essentials at a glance

| Kotlin | G# | What to notice |
| --- | --- | --- |
| `val name = "Ada"` | `let name = "Ada"` | The binding cannot be reassigned; referenced objects are not necessarily deeply immutable. |
| `var count: Int = 0` | `var count int32 = 0` | Types follow names without a colon. |
| `fun add(x: Int, y: Int): Int` | `func add(x int32, y int32) int32` | Function declarations use `func`. |
| `String?`, `null` | `string?`, `nil` | Nullable types are explicit; the absent value has a different spelling. |
| `value ?: fallback` | `value ?? fallback` | G# uses `??` for coalescing. Its `?:` is a ternary conditional, not Kotlin's Elvis operator. |
| `value?.length` | `value?.Length` | Safe access is familiar; .NET member names commonly use PascalCase. |
| `value!!` | `value!!` | An assertion, not a safe fallback. Prefer handling absence when it is expected. |
| `List<Int>` | `List[int32]` after importing .NET collections | Square brackets denote generic arguments. .NET `List[T]` is mutable; it is not Kotlin's read-only `List<T>` interface. |
| `println(value)` | `Console.WriteLine(value)` | Use the .NET console API. |
| `copy(years = 3)` | `with { Years = 3 }` | Copy/update is familiar, but don't assume every object-model rule is identical. |
| `call(name = value)` | `call(name: value)` | Named call arguments use a colon. |
| `.use { ... }` on a resource | `using let resource = ...` | Cleanup follows .NET's disposable-resource contracts. |

For visibility defaults, type constraints, and other precise rules, use the [language specification](../ref/spec.md); similar spelling is not a promise of identical semantics.

## A complete program

This G# program is checked in as `samples/WebsiteKotlin.gs` and verified with the advertised SDK:

```gsharp title="developer.gs"
package Examples.Kotlin

import System

data class Developer(Name string, Years int32)

func label(person Developer?) string ->
if let known = person {
    "${known.Name}: ${known.Years}"
} else {
    "unassigned"
}

let ada = Developer("Ada", 2)
let next = ada with{Years = 3}
Console.WriteLine(label(next))
Console.WriteLine(label(nil))
Console.WriteLine(ada == Developer("Ada", 2))
```

```text
Ada: 3
unassigned
True
```

G#'s arrow body can return the value of an `if let` expression directly. A block body with explicit `return` statements is also valid; the checked output is identical.

The comparable Kotlin shape is:

```kotlin
data class Developer(val name: String, val years: Int)

fun label(person: Developer?): String =
    if (person != null) "${person.name}: ${person.years}" else "unassigned"

fun main() {
    val ada = Developer("Ada", 2)
    val next = ada.copy(years = 3)
    println(label(next))
    println(label(null))
    println(ada == Developer("Ada", 2))
}
```

The last Kotlin line prints `true`; the .NET console prints `True`. More importantly, both examples compare the data rather than asking whether the two variables reference one object. In G#, use `Object.ReferenceEquals` when object identity is the question.

## Nullable flow: familiar tools, different boundaries

`if let` introduces a non-null value inside its branch. It is language syntax, not Kotlin's `.let { ... }` library function. G# also has `guard let` for early-exit handling and `while let` for repeated nullable bindings.

Safe access and coalescing compose naturally:

```gsharp
let length = name?.Length ?? 0
```

This is an expression excerpt; `name` is a `string?` supplied by the surrounding program.

Do not transfer assumptions about Kotlin/JVM platform types to imported .NET APIs. G# uses CLR nullable metadata, and unannotated imported reference types can require explicit absence handling. See [nullable imported references](../tour/dotnet-interop.md#nullable-imported-references) and [control flow](../tour/control-flow.md).

## Data models and collections

Use `data class` for reference-typed structural data and `data struct` for value-typed structural data. A plain class, a data class, and a value type are different design choices. Copy/update does not make nested mutable state deeply immutable.

G# uses .NET collections. Import `System.Collections.Generic` for `List[T]` and `Dictionary[K,V]`, and `System.Linq` for LINQ operations. A `let` binding can still refer to a list whose contents change. G# slices are CLR arrays, not Kotlin read-only lists.

The [interop example](../tour/dotnet-interop.md) and [Trail walkthrough](../tutorials/trail.md) show these choices in executable code.

## Structured concurrency is a concept, not a direct API mapping

Kotlin coroutine builders such as `launch` belong to `kotlinx.coroutines`. G# provides `go`, channels, and `scope` as language features backed by its .NET runtime support.

In G#, start owned child work with `go call(...)` inside a `scope`. The scope joins its children and observes failures. Do not translate a Kotlin `launch` into an unscoped `go` and assume the same lifetime or error behavior.

Use `async func` and `await` for .NET task-based APIs. An `async sequence[T]` offers asynchronous iteration, but is not a drop-in replacement for every Kotlin `Flow` operator or coroutine-context rule.

Start with the [concurrency Tour](../tour/concurrency.md), then inspect [Trail's bounded pipeline](../tutorials/trail.md#4-coordinate-a-bounded-worker-pool).

## A practical route into .NET

1. Run [Hello, G#](../getting-started/quickstart.md).
2. Build [Trail](../tutorials/trail.md): data models, nullable filtering, channels, resource cleanup, and .NET JSON.
3. Set up [VS Code](../tooling/vscode.md) and [debugging](../tooling/debugging.md).
4. Consult [CLR interop](../ref/clr-interop.md) when integrating a real library.

Kotlin reference material: [data classes](https://kotlinlang.org/docs/data-classes.html), [null safety](https://kotlinlang.org/docs/null-safety.html), and [coroutines](https://kotlinlang.org/docs/coroutines-basics.html).
