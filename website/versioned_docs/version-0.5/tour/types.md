---
title: "Tour: Types and values"
sidebar_position: 3
draft: false
description: "Model values with data types, classes, collections, and explicit nullability."
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

A data type is what a C# `record` / `record struct` is on the CLR: `ToString()` prints `Point { X = 3, Y = 4 }` (current culture, only public instance fields and readable public instance properties (no static members, indexers or pointer-typed members), plus whatever a data base's `PrintMembers` prints), it implements `IEquatable<T>`, and it carries the record `PrintMembers` slot. A `data class` additionally has the record copy constructor and `<Clone>$`; a `data struct` copies by value and has neither. Earlier releases printed `Point(X=3, Y=4)` with the invariant culture; see the [release notes](../release-notes.md) for the breaking change. `inline struct` is not a data type and keeps its own `UserId(value=u-1)` text. `Deconstruct` is G#'s own: positional components for a primary constructor, otherwise fields then auto-properties.

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

Native `slice[T]` and `readonly slice[T]` are distinct from the CLR arrays above. They copy length/capacity descriptors while sharing managed storage. Ranges share storage too; `Clone()` copies elements. Retain `.Append(...)` results because growth can allocate. Readonly prevents slot writes, not mutation of referenced objects. Convert explicitly at CLR boundaries with `slice[T].FromArray(array)` (shares exact storage) and `ToArray()` (copies).

The checked-in `samples/NativeSlices.gs` demonstrates allocation-free range processing. This smaller example shows aliasing and copying:

```gsharp
package Website.NativeSlices

import System

let values = slice[int32].Create(2, 4)
values[0] = 7
let view = values[0 .. 1]
view[0] = 9
let copied = values.Clone()
copied[0] = 1
Console.WriteLine(values[0])
Console.WriteLine(copied[0])
```

Expected output:

```text
9
1
```

See the [native slice contract](../ref/spec.md#native-shared-storage-slices) for nil/empty values, growth and readonly permissions.

## Immutable byte strings

**Available in 0.5.199:** `bytestring` is an immutable arbitrary-byte value,
not a CLR text string or a promise that its bytes are valid UTF-8. This capability
requires a matching compiler/runtime. Ordinary `string` remains `System.String`.

```gsharp
func Payload(packet bytestring) bytestring {
    if !packet.StartsWith(b"\xCA\xFE") {
        throw System.FormatException("Invalid header")
    }
    return packet[2..]
}
```

Length and indices count bytes. `b"\xFF\0"` has two bytes; dollar signs in a
byte literal are ordinary data. Scalar source characters and valid `\u`/`\U`
escapes encode to UTF-8, while `\xHH` inserts exactly one byte. Equality, hashing
and ordering compare contents; ranges share immutable storage. Use `Detach()`
to copy a retained substring into compact storage.

`default(bytestring)` is empty; `bytestring?` can additionally be `nil`.
`Gsharp.Values.ByteString.CopyFrom` snapshots a readonly native byte slice or
`ReadOnlySpan[uint8]`; `ToArray()`, `ToSlice()` and `CopyTo` copy to independent
writable storage. There is no implicit text conversion or public backing view.
`ToString()` is a bounded escaped diagnostic, not decoded text.

Text boundaries require explicit policies:
`ByteString.EncodeUtf8(text, Utf16Encoding.Strict)` encodes CLR text;
`value.DecodeUtf8(Utf8Decoding.Strict)` decodes complete shortest-form scalars.
Import `Gsharp.Values` for the nominal type and policies.
`ReplaceUnpairedCodeUnit` replaces each unpaired UTF-16 surrogate.
`ReplaceInvalidByte` emits U+FFFD for each invalid byte, advancing one byte;
a valid encoded U+FFFD consumes three bytes. No normalization or BOM
insertion/stripping occurs. NUL remains content.
Strict conversions throw `ByteStringEncodingException` with `InputKind`
(`ByteStringInputKind.Utf8` or `.Utf16`) and zero-based `Offset` relative to
the input value. They return no partial result. See the
[text-boundary reference](../ref/spec.md#explicit-utf-8-text-boundaries) for
policy and exception details. Scalar iteration remains deferred.

Visible user types/aliases named `bytestring` win ordinary lookup;
`$bytestring` never selects the native alias. A byte literal always has the
nominal runtime type, regardless of shadowing.

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

Use `data object { ... }` when you want value-style equality, `ToString`, deconstruction, and `with`-copy support. Its `ToString` prints `{ Name = David, Count = 2 }` with no type name, and it does not get a record `PrintMembers`.

## Zero values

A composite literal with no fields uses the zero value for each field. A `var` declaration with an explicit type and no initializer also starts at the type's zero value: `0` for numeric types, `False` for `bool`, `nil` for reference types (including `string`), and `nil` for nullable values.

Collection declarations synthesize a **sound empty instance**, not `nil`: `var m map[string, int32]` starts as an empty map, `var s []int32` as a zero-length CLR array, `var a [3]int32` as three zeroed elements, and `var q sequence[int32]` as an empty sequence. Arrays cannot grow; use `List[T]` or retain the result of native slice `.Append(...)`. A default native slice is a present empty descriptor (length and capacity zero), not `nil`; `slice[T]?` adds absence. Channel globals and fields require an initializer (`GS0520`); locals must be assigned before use (`GS0522`). Use `chan[int32]()` or `chan[int32](capacity)`.

The CLR default of a type can be spelled directly as `default(T)` for any type `T`. For array, map and sequence references this is `nil`, unlike their synthesized declaration defaults. A native slice descriptor is a value type whose CLR default remains present and empty. The bare `default` literal is accepted wherever the target type is known from context.

## A note on `nil` vs `null`

The null literal in G# is spelled `nil`, not `null`. Typing `null` in a value position reports `GS0273` and the binder treats it as `nil` so the rest of the expression still typechecks.

Next: [Tour: Control flow](control-flow.md).
