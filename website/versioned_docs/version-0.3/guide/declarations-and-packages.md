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

A non-alias import whose full path names a type also acts like C# `using static`: the type's `shared` / static members are available as an unqualified fallback. Namespace imports and aliases do not hoist statics, and ambiguous static imports are diagnosed at the use site.

```gsharp
import System.Math

let hypotenuse = Sqrt(3.0 * 3.0 + 4.0 * 4.0)
```

## Visibility

G# accepts `public`, `internal`, and `private` in the grammar positions where declarations support accessibility. Defaults are context-specific. In guides, prefer explicit visibility for public API examples and omit it for local or private examples. A top-level `private func` is emitted as assembly-internal so sibling types in the same assembly can call it, but it is not exported to consumers; `private` members inside user types remain true CLR private members.

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


## Functions and methods

A function declaration starts with `func`. `async func` declares an async function. Receiver clauses attach behavior to a receiver type and are the canonical extension-function style for types this package does **not** own (imported CLR types, BCL primitives, types from referenced packages); methods on owned classes should be declared inside the class body. The same-package receiver-clause form emits the soft `GS0314` warning.

```gsharp
func Add(x int32, y int32) int32 {
    return x + y
}

func Square(x int32) int32 -> x * x

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

Parameters may carry a ref-kind modifier (`ref`, `out`, `in`, or `scoped`) and may declare a compile-time-constant default value to become optional. Two functions sharing a name are overloads when they differ by parameter types, arity, or ref-kinds; differing by return type alone is not a distinguishing signature. See the [feature matrix](/docs/ref/feature-matrix) for the full capability table.

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

Expression-bodied members use the G# arrow `->`, not C# `=>`. The form is available for free functions, methods, read-only properties, accessors, indexers, operators, and conversion operators; constructors, finalizers, and local functions keep block bodies.

A named delegate type is a top-level type alias whose RHS is `delegate func(...)`:

```gsharp
type Handler = delegate func(sender Object, e EventArgs)
```

Named delegates emit as real CLR `MulticastDelegate`-derived types so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types.

## Type declarations

The aggregate keyword (`class`, `struct`, `enum`, `interface`) is the declaration head. `data` adds structural synthesis (equality, `with`-copy, deconstruction). `inline struct` declares a single-field value wrapper. `partial class`, `partial struct`, and `partial interface` split one type across files or generated sources; every duplicate part must carry `partial`, and partial enums are not supported. `sealed class` / `sealed interface` declare Kotlin-style closed hierarchies. Payload-bearing enums (`enum Shape { Circle(r float64); Square(s float64) }`) are discriminated unions. The `type` keyword is retained for aliases (`type Count = int32`) and named delegates (`type Greeter = delegate func(name string)`).

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

Classes and structs can declare nested `class`, `struct`, `interface`, or `enum` types. User-declared nested types currently resolve by simple name in the compilation; `Outer.Inner` qualification is not added for user types.

A primary-constructor parameter list accepts a trailing variadic `name ...T` parameter (`class`, `struct`, `data class`, `data struct`, `inline struct`). The variadic param promotes to a `[]T` auto-field with the same name and call binding follows the standard variadic pack / pass-through rules. 
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

Indexers are properties named `this[...]` and lower to CLR `Item` default members:

```gsharp
class Buffer {
    private var data []int32 = [4]int32

    prop this[i int32] int32 {
        get -> data[i]
        set -> data[i] = value
    }
}
```

Static initialization logic lives in `shared { init { ... } }`. Static field initializers run first; one or more `init` blocks are concatenated in source order into the type initializer and run once before first static access.

```gsharp
class Tables {
    shared {
        private let Values []int32 = [4]int32
        init {
            Values[0] = 1
        }
    }
}
```

User-defined conversion operators are declared as static operator functions on owned structs. Implicit conversions apply in target-typed contexts; explicit conversions use the target-type call form.

```gsharp
struct Bytes {
    var Value []uint8
}

func operator implicit (b Bytes) []uint8 -> b.Value
func operator explicit (value []uint8) Bytes -> Bytes{Value: value}
```


## Annotations

Annotations start with `@` and may include a use-site target such as `@field:` or `@return:`. They are part of declaration syntax and map toward CLR metadata attributes. A function annotated with `@DllImport("libname", ...)` whose body is a single `;` is bound as a P/Invoke stub; see [CLR interop &gt; Unmanaged interop (P/Invoke)](../ref/clr-interop.md#unmanaged-interop-pinvoke).
