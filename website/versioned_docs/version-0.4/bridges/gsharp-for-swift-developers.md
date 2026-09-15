---
title: "G# for Swift developers"
description: "Bring Swift experience to G#: compare value types, optionals, functions, resource lifetime, and structured concurrency on .NET."
sidebar_position: 4
---

# G# for Swift developers

G# offers familiar ideas: `let` and `var`, value and reference types, explicit nullable values, and structured work. The platform is different. You build .NET assemblies and use .NET libraries; G# does not directly run Swift packages, SwiftUI, or Cocoa applications.

Start with [installation](../getting-started/install.md), then compare concepts rather than treating similar syntax as an identical contract.

## Familiar syntax, important differences

| Swift | G# | Important distinction |
| --- | --- | --- |
| `let name = "Ada"` | `let name = "Ada"` | A binding is not the same as a deeply immutable object graph. |
| `var count: Int32 = 0` | `var count int32 = 0` | Types follow names without a colon. |
| `func add(_ x: Int32, _ y: Int32) -> Int32` | `func add(x int32, y int32) int32` | Swift argument-label rules do not transfer mechanically. G# named arguments use `name: value`. |
| `String?`, `nil` | `string?`, `nil` | Explicit absence is familiar. |
| `if let` / `guard let` | `if let` / `guard let` | Learn the G# binding and control-flow rules rather than assuming every Swift form exists. |
| `value ?? fallback` | `value ?? fallback` | Both make the fallback explicit. |
| `value!` | `value!!` | G# uses two exclamation marks for a null assertion. Prefer handling expected absence. |
| `[Int32]` | `[]int32` | G# slices are CLR arrays. They do not have Swift Array's value/copy-on-write semantics. |
| `print(value)` | `Console.WriteLine(value)` | Call the .NET console API. |
| `self` | `this` | Receiver naming differs. |
| `protocol` | `interface` | This is a conceptual correspondence, not a promise that associated types and protocol features map one-for-one. |
| `defer { ... }` | `defer call()` | G# defers a call rather than an arbitrary statement block. |

Swift's `Int` is native-width. Choose a deliberate width in G#: `int32` and `int64` are fixed-width, while `nint` is native-width. G#'s friendly `int` alias means `int32`, not Swift's platform-sized `Int`.

## A complete value-and-optional example

The G# program is `samples/WebsiteSwift.gs`, checked with the advertised SDK:

```gsharp title="point.gs"
package Examples.Swift

import System

data struct Point {
    var X int32
    var Y int32
}

func describe(point Point?) string {
    guard let known = point else {
        return "no position"
    }
    return "${known.X}, ${known.Y}"
}

let origin = Point{X: 0, Y: 0}
let moved = origin with{X = 3}
Console.WriteLine(describe(moved))
Console.WriteLine(describe(nil))
Console.WriteLine(origin == Point{X: 0, Y: 0})
```

```text
3, 0
no position
True
```

The corresponding Swift program is checked in at `samples/SwiftBridge/example.swift`:

```swift title="point.swift"
struct Point: Equatable {
    var x: Int32
    var y: Int32
}

func describe(_ point: Point?) -> String {
    guard let known = point else { return "no position" }
    return "\(known.x), \(known.y)"
}

let origin = Point(x: 0, y: 0)
var moved = origin
moved.x = 3
print(describe(moved))
print(describe(nil))
print(origin == Point(x: 0, y: 0))
```

Both keep the original point unchanged and handle the absent case explicitly. Swift prints `true` on the last line; the .NET console prints `True`.

## Value types, references, and lifetime

Use `struct` for G# value types and `class` for reference types. `data struct` adds structural equality and copy/update behavior to a value type; `data class` offers structural data semantics on a reference type.

Do not transfer Swift collection assumptions to the CLR. Assigning a G# array reference to another binding does not create an independent Swift-style value. A `let` binding can still refer to mutable data.

Swift uses ARC for class-instance lifetime. G# uses the CLR's managed memory model. Do not rely on prompt deinitialization to close a file or release another external resource. Use `using let` with .NET disposable resources, or an appropriate `defer` call.

See [types and values](../guide/types-and-values.md) and [errors and cleanup](../guide/errors-and-cleanup.md).

## Optionals and .NET boundaries

`T?`, `nil`, `?.`, and `??` are useful starting points. Imported .NET nullable metadata and unannotated library APIs have their own rules; G#'s model is not just a different spelling of Swift's `Optional` implementation.

An ordinary .NET dictionary indexer can throw when a key is absent. Use an appropriate `TryGetValue` or nullable-returning API instead of assuming Swift Dictionary subscript behavior.

Start with the [concept quick reference](../ref/quick-reference.md) and then the [interop reference](../ref/clr-interop.md).

## Concurrency: compare ownership, not only keywords

Swift has task groups, actors, and isolation/`Sendable` rules. G# has channels, `go`, `scope`, and .NET task-based async APIs. These are not interchangeable runtimes or a shared set of compile-time guarantees.

In G#, `scope` joins owned child work and observes failures. It does not turn ordinary mutable objects into isolated actors. Use channels, locks, immutable data, or other appropriate .NET synchronization for shared state.

Read the [concurrency Tour](../tour/concurrency.md), then compare the [ten runnable Go/G# patterns](/concurrency), including their explicit cancellation and cleanup contracts. That comparison page identifies its own example and benchmark versions.

## Extensions and errors

Swift's `extension Type { ... }` block is not G# syntax. G# uses receiver functions, with ownership-specific rules described in [Effective G#](../guide/effective-gsharp.md#methods-receiver-functions-and-extension-functions). Follow the published language version; do not assume an in-progress language-design change is already available.

G# uses CLR exceptions and `try`/`catch`; it does not encode Swift's `throws` effect in the same way. Nullable results and exceptions solve different problems.

## A practical next step

Build [Trail](../tutorials/trail.md) to work with data models, a nullable filter, scoped workers, file streams, hashing, and .NET JSON in one application. Then set up [VS Code](../tooling/vscode.md) and [debugging](../tooling/debugging.md).

Swift reference material: [The Swift Programming Language](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/), especially structures/classes, automatic reference counting, optionals, and concurrency.
