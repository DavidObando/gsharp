---
title: "Tour: Types and values"
sidebar_position: 3
draft: false
---

# Tour: Types and values

G# has value-oriented structs, reference-oriented classes, data structs, records, arrays, slices, maps, tuples, sequences, channels, and function types. This chapter focuses on the everyday aggregate and collection shapes.

## Structs and classes

A `struct` is value-like. Assigning one struct variable to another copies the value.

```gsharp title="Struct.gs"
package GSharp.Example.Struct

import System

type Point struct {
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

type Point class {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = p
q.X = 99
Console.WriteLine(p.X)
```

## Data structs and records

`data struct` adds ergonomic value behavior such as structural equality and copy support. `record` is a context-sensitive alias for `data struct`.

```gsharp title="DataStruct.gs"
package GSharp.Example.DataStruct

import System

type Point data struct {
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

type Point data struct {
    x int32
    y int32
}

let p = Point{x: 3, y: 4}
let same = p.copy()
let movedX = p.copy(x = 10)
let viaWith = p with { x = 10 }
let (px, py) = p

Console.WriteLine(p == same)
Console.WriteLine(movedX == viaWith)
Console.WriteLine(px + py)
```

## Arrays, slices, and maps

Fixed arrays use `[N]T`; slices use `[]T` and support `len`, `cap`, indexing, and `append`.

```gsharp title="Slices.gs"
package GSharp.Example.Slices

import System

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))
Console.WriteLine(cap(nums))
Console.WriteLine(nums[0])

nums = append(nums, 40)
Console.WriteLine(len(nums))
Console.WriteLine(nums[3])
```

```text
3
3
10
4
40
```

Maps use `map[K]V` for G# map literals, and CLR collections such as `Dictionary[string, int32]` are available through imports.

```gsharp
package Tour.Types

import System

var counts = map[string]int32{"gsharp": 1}
counts["gsharp"] = counts["gsharp"] + 1
Console.WriteLine(counts["gsharp"])
```

## Zero values

A composite literal with no fields uses the zero value for each field. A `var` declaration with an explicit type and no initializer also starts at the type's zero value: `0` for numeric types, `False` for `bool`, empty for `string`, and `nil` for nullable values.

Next: [Tour: Control flow](/docs/tour/control-flow).
