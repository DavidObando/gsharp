---
title: "Tour: Types and values"
sidebar_position: 3
draft: false
---

# Tour: Types and values

G# has value-oriented structs, reference-oriented classes, data structs, data classes, arrays, slices, maps, tuples, sequences, channels, and function types. This chapter focuses on the everyday aggregate and collection shapes.

## Structs and classes

A `struct` is value-like. Assigning one struct variable to another copies the value.

```gsharp title="Struct.gs"
package GSharp.Example.Struct

import System

struct Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
Console.WriteLine(p.X + p.Y)

p.X = 10
Console.WriteLine(p.X)

var q = p
q.X = 99
Console.WriteLine(p.X)
Console.WriteLine(q.X)

var origin = Point{}
Console.WriteLine(origin.X + origin.Y)
```

```text
7
10
10
99
0
```

A `class` is reference-like. Assigning a class value copies the reference, so both variables observe later field changes.

```gsharp
package Tour.Types

import System

class Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = p
q.X = 99
Console.WriteLine(p.X)
```

## Data classes and data structs

`data struct` and `data class` add ergonomic value-record behaviour: structural equality, `with`-copy, and deconstruction. `data struct` is value-typed; `data class` is reference-typed.

```gsharp title="DataStruct.gs"
package GSharp.Example.DataStruct

import System

data struct Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = Point{X: 3, Y: 4}
var r = Point{X: 3, Y: 5}

Console.WriteLine(p == q)
Console.WriteLine(p != r)
Console.WriteLine(q == r)
```

```text
True
True
False
```

The longer data-struct sample also shows `copy`, `with`, and deconstruction:

```gsharp title="DataStructErgonomics.gs"
package GSharp.Example.DataStructErgonomics

import System

data struct Point {
    x int32
    y int32
}

let p = Point{x: 3, y: 4}
let same = p.copy()
let movedX = p.copy(x: 10)
let viaWith = p with { x = 10 }
let (px, py) = p

Console.WriteLine(p == same)
Console.WriteLine(movedX == viaWith)
Console.WriteLine(px + py)
```

## Arrays, slices, and maps

Fixed arrays use `[N]T`; slices use `[]T` and support indexing, the `.Length` property, and growth through `List[T]`. The Go-style `len`, `cap`, `append`, and `delete` built-ins ship in the opt-in [`Gsharp.Extensions.Go`](../extensions/go-builtins) package.

```gsharp title="Slices.gs"
package GSharp.Example.Slices

import System

var nums = []int32{10, 20, 30}
Console.WriteLine(nums.Length)
Console.WriteLine(nums[0])

// Grow with List[T] when you need mutable, grow-and-copy semantics.
import System.Collections.Generic

var grown = List[int32]()
for v in nums {
    grown.Add(v)
}
grown.Add(40)
Console.WriteLine(grown.Count)
Console.WriteLine(grown[3])
```

```text
3
10
4
40
```

Maps use `map[K,V]` for G# map literals, and CLR collections such as `Dictionary[string, int32]` are available through imports.

```gsharp
package Tour.Types

import System

var counts = map[string,int32]{"gsharp": 1}
counts["gsharp"] = counts["gsharp"] + 1
Console.WriteLine(counts["gsharp"])
```

## Zero values

A composite literal with no fields uses the zero value for each field. A `var` declaration with an explicit type and no initializer also starts at the type's zero value: `0` for numeric types, `False` for `bool`, `nil` for reference types (including `string`), and `nil` for nullable values.

The same zero value can be spelled directly as `default(T)` for any type `T` — including unconstrained type parameters inside generic functions, where `default(T)` lowers to `initobj T` so both reference-type and value-type substitutions Just Work. The bare `default` literal (without `(T)`) is accepted wherever the target type is known from context: in a `let`/`var` with an explicit type clause (`let x int32 = default`), in `return default` when the function's return type is known, as an argument to a typed parameter, and as a conditional branch typed by its sibling.

## Friendly numeric aliases

G# also accepts ten friendly aliases for the canonical width-bearing numeric primitives: `int` → `int32`, `uint` → `uint32`, `long` → `int64`, `ulong` → `uint64`, `short` → `int16`, `ushort` → `uint16`, `byte` → `uint8`, `sbyte` → `int8`, `float` → `float32`, and `double` → `float64`. The alias resolves to the canonical type at the binder, so `let x int = 1` and `let x int32 = 1` are equivalent — diagnostics, `typeof`, hover, and IL always display the canonical width-bearing name.

## A note on `nil` vs `null`

The null literal in G# is spelled `nil`, not `null`. Coming from C#, Kotlin, Java, or TypeScript? Your fingers will reach for `null` — and the compiler will catch it for you. Typing `null` in a value position reports `GS0273` ("`'null'` is not a literal in G#. Did you mean `'nil'`?") and the binder treats it as `nil` so the rest of the expression still typechecks. The diagnostic only fires when nothing in scope is named `null`; the identifier itself is not a keyword, so a function or local named `null` is legal and resolves normally.

Next: [Tour: Control flow](/docs/tour/control-flow).
