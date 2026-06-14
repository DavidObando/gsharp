---
title: "Declarations and packages"
sidebar_position: 3
draft: false
---

# Declarations and packages

Declarations define the package-level and type-level shape of a G# program. This guide summarizes the current parser and binder behavior; the full EBNF is in the [language specification](/docs/ref/spec#appendix-full-parser-grammar).

## Packages

A file may begin with a package declaration:

```gsharp
package Company.Product.Feature
```

The compiler supports multi-file and multi-package builds in the emit path. Top-level statements are allowed, but mixing top-level statements with an explicit `Main` entry point is diagnosed.

## Imports and aliases

Imports bring packages or CLR namespaces into scope. Use an alias when two imports would otherwise compete or when a long CLR namespace needs a local name.

```gsharp
import System
import Text = System.Text
```

The compiler can add an implicit `System` import by default. Use `/noimplicitimports` when documenting or testing examples that should show every dependency explicitly.

## Visibility

G# accepts `public`, `internal`, and `private` in the grammar positions where declarations support accessibility. Defaults are context-specific, following [ADR-0006](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0006-visibility.md) and [ADR-0014](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0014-visibility-default.md). In guides, prefer explicit visibility for public API examples and omit it for local or private examples.

## Variables and constants

Use `const`, `let`, and `var` declarations at package scope or statement scope. `let` and `const` require initializers; `var` can be initialized or declared with a type for the default value.

```gsharp
const answer = 42
let greeting = "hello"
var count int32
var total = 0
```

Deconstruction is available in `let` forms, and multi-target assignment supports identifier lists.

```gsharp
let (x, y) = pair
let { Name = n, Age = a } = person
left, right = right, left
```

The legacy `name := expr` short declaration was removed by [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md). Use `let name = expr` (immutable) or `var name = expr` (mutable) at every binding site.

Rationale: [ADR-0008](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0008-variable-bindings.md), [ADR-0015](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0015-multi-target-assignment.md), and [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md).

## Functions and methods

A function declaration starts with `func`. `async func` declares an async function. Receiver clauses attach behavior to a receiver type and are the canonical extension-function style. Per [ADR-0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md), receiver clauses are reserved for types this package does **not** own (imported CLR types, BCL primitives, types from referenced packages); methods on owned classes should be declared inside the class body. The same-package receiver-clause form emits the soft `GS0314` warning.

```gsharp
func Add(x int32, y int32) int32 {
    return x + y
}

class Point {
    var X int32
    var Y int32

    func LengthSquared() int32 {
        return X * X + Y * Y
    }
}

// Extension on a type this package does not own (a BCL primitive):
func (value int32) Abs() int32 {
    if value < 0 { return -value }
    return value
}
```

Generic functions use bracketed type parameters and bracketed type arguments.

Parameters may carry a ref-kind modifier (`ref`, `out`, `in`, or `scoped`) and may declare a compile-time-constant default value to become optional. Two functions sharing a name are overloads when they differ by parameter types, arity, or ref-kinds; differing by return type alone is not a distinguishing signature. See ADR-0060 (ref parameters), ADR-0063 (overloading and optional parameters), and the [feature matrix](/docs/ref/feature-matrix) for the full capability table.

```gsharp
func greet(name string = "world", excited bool = false) string {
    return excited ? "hi, $name!" : "hi, $name"
}

// Overloads — differ by arity.
func area(width int32, height int32) int32 { return width * height }
func area(side int32) int32                { return side * side }

// Ref-kind parameters.
func swap[T](ref a T, ref b T) {
    let t = a
    a = b
    b = t
}

func tryParse(s string, out value int32) bool {
    value = 0
    if Int32.TryParse(s, out value) { return true }
    return false
}
```

A function can declare a managed-pointer return with `ref` before the return type clause — `func at(arr []int32, i int32) ref int32 { return ref arr[i] }`. Diagnostics `GS0248`–`GS0255` cover the supporting rules.

A named delegate type is a top-level type alias whose RHS is `delegate func(...)`:

```gsharp
type Handler = delegate func(sender Object, e EventArgs)
```

Named delegates emit as real CLR `MulticastDelegate`-derived types so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types (ADR-0059).

## Type declarations

The aggregate keyword (`class`, `struct`, `enum`, `interface`) is the declaration head — see [ADR-0078](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0078-kotlin-style-type-declaration-grammar.md). `data` adds record-style synthesis (equality, `with`-copy, deconstruction). `inline struct` declares a single-field value wrapper. `sealed class` / `sealed interface` declare Kotlin-style closed hierarchies. Payload-bearing enums (`enum Shape { Circle(r float64); Square(s float64) }`) are discriminated unions. The `type` keyword is retained for aliases (`type Count = int32`) and named delegates (`type Greeter = delegate func(name string)`).

```gsharp
data struct Point {
    X int32
    Y int32
}

open class Service(name string) {
    prop Name string { get; }
}

enum Result { Ok, Failed }
```

Classes can have primary constructors, explicit `init` constructors, base clauses, fields, methods, properties, events, and `shared` static members. Base classes must be open to derive from; overriding uses `override`.

A primary-constructor parameter list accepts a trailing variadic `name ...T` parameter (`class`, `struct`, `data class`, `data struct`, `inline struct`). The variadic param promotes to a `[]T` auto-field with the same name and call binding follows the standard variadic pack / pass-through rules. See [ADR-0103](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0103-primary-ctor-variadic.md).

```gsharp
class Tags(name string, tags ...string) { }

let t = Tags("project", "a", "b", "c")   // t.tags is []string{"a", "b", "c"}
```

## Properties, events, and static members

Properties use contextual `prop` and may have accessors. Events use contextual `event` and may declare `add`, `remove`, and `raise` accessors. Static members live in a contextual `shared` block.

```gsharp
class Counter {
    shared {
        var Created int32
    }

    prop Value int32 { get; }
    event Changed () -> void
}
```

See [ADR-0051](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0051-property-declarations.md), [ADR-0052](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0052-event-declarations.md), and [ADR-0053](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0053-static-members.md).

## Annotations

Annotations start with `@` and may include a use-site target such as `@field:` or `@return:`. They are part of declaration syntax and map toward CLR metadata attributes. A function annotated with `@DllImport("libname", ...)` whose body is a single `;` is bound as a P/Invoke stub (see [CLR interop &gt; Unmanaged interop (P/Invoke)](../ref/clr-interop.md#unmanaged-interop-pinvoke) and ADR-0086).
