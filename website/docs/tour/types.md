---
title: "Tour: Types and values"
sidebar_position: 3
draft: false
---

# Tour: Types and values

G# has value-oriented structs, reference-oriented classes, data structs, data classes, arrays, slices, maps, tuples, sequences, channels, and function types. This chapter focuses on everyday aggregate and collection shapes.

## Structs and classes

A `struct` is value-like. Assigning one struct variable to another copies the value.

```gsharp title="Struct.gs"
package GSharp.Example.Struct

import System

struct Point {
    var X int32
    var Y int32
}

func Main() {
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
}
```

```text
7
10
10
99
0
```

A `class` is reference-like. Assigning a class value copies the reference, so both variables observe later field changes.

```gsharp title="Class.gs"
package Tour.Types.Class

import System

class Point {
    var X int32
    var Y int32
}

func Main() {
    var p = Point{X: 3, Y: 4}
    var q = p
    q.X = 99
    Console.WriteLine(p.X)
}
```

## Data classes and data structs

`data struct` and `data class` add ergonomic value-record behavior: structural equality, `with`-copy, and deconstruction. `data struct` is value-typed; `data class` is reference-typed.

```gsharp title="DataStruct.gs"
package GSharp.Example.DataStruct

import System

data struct Point {
    var X int32
    var Y int32
}

func Main() {
    var p = Point{X: 3, Y: 4}
    var q = Point{X: 3, Y: 4}
    var r = Point{X: 3, Y: 5}

    Console.WriteLine(p == q)
    Console.WriteLine(p != r)
    Console.WriteLine(q == r)
}
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
    var x int32
    var y int32
}

func Main() {
    let p = Point{x: 3, y: 4}
    let same = p.copy()
    let movedX = p.copy(x: 10)
    let viaWith = p with { x = 10 }
    let (px, py) = p

    Console.WriteLine(p == same)
    Console.WriteLine(movedX == viaWith)
    Console.WriteLine(px + py)
}
```

## Arrays and slices

Fixed-size literals use `[N]T{...}`. Slice literals use `[]T{...}`. The runtime allocation form `[n]T` creates a zero-initialized `[]T` of length `n`. Native rectangular arrays use `[,]T` types, `[rows, columns]T` allocation, and `grid[row, column]` indexing.

```gsharp title="ArraysAndSlices.gs"
package GSharp.Example.ArraysAndSlices

import System

func zeros(n int32) []int32 {
    return [n]int32
}

func Main() {
    let fixed = [3]int32{10, 20, 30}
    let slice = []int32{1, 2, 3}
    let runtime = zeros(4)
    let matrix = [2, 3]int32{1, 2, 3, 4, 5, 6}
    matrix[1, 2] = 42

    Console.WriteLine(fixed[0])
    Console.WriteLine(slice.Length)
    Console.WriteLine(runtime.Length)
    Console.WriteLine(runtime[0])
    Console.WriteLine(matrix[1, 2])
    Console.WriteLine(matrix.GetLength(1))
}
```

## CLR collection initializers

CLR collections can be created with `List[T]{...}`, `HashSet[T]{...}`, and `Dictionary[K,V]{...}` initializers. Dictionary entries use `key: value`; use `[key] = value` when the key is an identifier expression.

```gsharp title="CollectionInitializers.gs"
package GSharp.Example.CollectionInitializers

import System
import System.Collections.Generic

func Main() {
    var primes = List[int32]{2, 3, 5, 7}
    var seen = HashSet[string]{"red", "green", "blue"}
    var counts = Dictionary[string, int32]{"gsharp": 1, "dotnet": 2}

    primes.Add(11)
    counts["gsharp"] = counts["gsharp"] + 1

    Console.WriteLine(primes.Count)
    Console.WriteLine(seen.Contains("red"))
    Console.WriteLine(counts["gsharp"])
}
```

Maps use `map[K,V]` for G# map literals, and CLR collections such as `Dictionary[string, int32]` are available through imports.

```gsharp title="Maps.gs"
package Tour.Types.Maps

import System

func Main() {
    var counts = map[string,int32]{"gsharp": 1}
    counts["gsharp"] = counts["gsharp"] + 1
    Console.WriteLine(counts["gsharp"])
}
```

## Anonymous objects

A field-only anonymous object is written `object { ... }`. Field types may be inferred, and fields are available through properties on the resulting value.

```gsharp title="AnonymousObject.gs"
package GSharp.Example.AnonymousObject

import System

func Main() {
    let profile = object {
        let Name = "Ada"
        let Language = "G#"
        let Score int32 = 99
    }

    Console.WriteLine(profile.Name)
    Console.WriteLine(profile.Score)
}
```

Use `data object { ... }` when you want value-style equality, `ToString`, deconstruction, and `with`-copy support.

## Zero values

A composite literal with no fields uses the zero value for each field. A `var` declaration with an explicit type and no initializer also starts at the type's zero value: `0` for numeric types, `False` for `bool`, `nil` for reference types (including `string`), and `nil` for nullable values.

The magic collection types are the exception: their zero value is a **sound empty instance**, not `nil` — `var m map[string, int32]` starts as an empty map you can index and assign into immediately, `var s []int32` as an empty slice you can `append` to, `var a [3]int32` as three zeroed elements, and `var q sequence[int32]` as an empty sequence. Channels are carved out: `var ch chan int32` without an initializer is an error (`GS0520`) — create channels explicitly with `make`.

The CLR default of a type can be spelled directly as `default(T)` for any type `T` (for the collection types above that is still `nil`, not the empty instance). The bare `default` literal is accepted wherever the target type is known from context.

## A note on `nil` vs `null`

The null literal in G# is spelled `nil`, not `null`. Typing `null` in a value position reports `GS0273` and the binder treats it as `nil` so the rest of the expression still typechecks.

Next: [Tour: Control flow](/docs/tour/control-flow).
