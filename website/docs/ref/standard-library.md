---
title: "Standard library and built-ins"
sidebar_position: 2
draft: false
---

# Standard library and built-ins

G# deliberately keeps its language-defined library small. Primitive types, collection intrinsics, channels, function values, and a few legacy built-in functions are provided by the compiler and evaluator. Most everyday library APIs are the .NET Base Class Library reached through imports and CLR interop; for example, printing in samples normally uses `Console.WriteLine` from the implicit or explicit `System` import. See [CLR interop](/docs/ref/clr-interop) for constructors, members, delegates, events, generics, attributes, and other .NET surface.

## Primitive types

The built-in primitive type symbols are exactly:

| Category | Types | Notes |
| --- | --- | --- |
| Boolean | `bool` | Literals are `true` and `false`. |
| Unsigned integers | `uint8`, `uint16`, `uint32`, `uint64`, `nuint` | Width-bearing names are canonical. Older aliases such as `uint` and `byte` are not built-in primitive names. |
| Signed integers | `int8`, `int16`, `int32`, `int64`, `nint` | Unsuffixed integer literals default to `int32`. Older aliases such as `int` and `long` are not built-in primitive names. |
| Floating point and decimal | `float32`, `float64`, `decimal` | Unsuffixed float literals default to `float64`; suffixes include `F`, `D`, and `M`. |
| Text | `char`, `string` | `char` is one UTF-16 code unit; `string` is the CLR string type. |
| Top and no-value | `object`, `void` | `object` is the universal upper bound; `void` is the no-result type. |
| Absence | `nil` | `nil` is a special literal type that converts to nullable types, not a named runtime type. |

`object` accepts implicit boxing from G# values backed by CLR types and from user value types. Explicit unboxing is available for CLR value types. `nil` converts to `T?`, and postfix `!!` asserts a nullable value is present.

## Operators on built-in types

G# does not perform cross-type operator promotion. Binary operators are defined for same-typed primitive operands unless otherwise noted.

- `bool`: `!`, `&`, `&&`, `|`, `||`, `^`, `==`, `!=`.
- Signed integers: unary `+`, unary `-`, `^`; binary `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `&^`, `<<`, `>>`, `==`, `!=`, `<`, `<=`, `>`, `>=`.
- Unsigned integers: unary `+`, `^`; binary `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `&^`, `<<`, `>>`, `==`, `!=`, `<`, `<=`, `>`, `>=`.
- `float32`, `float64`, `decimal`: unary `+`, unary `-`; binary `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`, `>`, `>=`.
- `char`: unary `+`; binary `==`, `!=`, `<`, `<=`, `>`, `>=`.
- `string`: `+`, `==`, `!=`.
- `object`: `==`, `!=`.

Shift counts are `int32`. Compound assignments exist for the corresponding binary operators: `+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=`, `^=`, `&^=`, `<<=`, and `>>=`.

## Intrinsic functions and operations

These names are recognized specially by the binder. They are language intrinsics, not methods imported from the BCL.

| Intrinsic | Form | Supported operands | Result | Import required |
| --- | --- | --- | --- | --- |
| `len` | `len(x)` | arrays, slices, strings, maps | `int32` length/count | `Gsharp.Extensions.Go` (ADR-0083) |
| `cap` | `cap(x)` | arrays, slices | `int32` capacity | `Gsharp.Extensions.Go` (ADR-0083) |
| `append` | `append(slice, value)` | first argument must be `[]T`; second converts to `T` | new `[]T` containing the appended value | `Gsharp.Extensions.Go` (ADR-0083) |
| `delete` | `delete(map, key)` | first argument must be `map[K]V`; key converts to `K` | no value; removes the key if present | `Gsharp.Extensions.Go` (ADR-0083) |
| `close` | `close(ch)` | `chan T` | no value; completes the channel writer | `Gsharp.Extensions.Go` (ADR-0082) |
| `make` | `make(chan T)` or `make(chan T, capacity)` | channel creation only | `chan T` | `Gsharp.Extensions.Go` (ADR-0082, via the inner `chan` clause) |
| receive | `<-ch` | `chan T` | next `T` value, or the closed-channel default value | `Gsharp.Extensions.Go` (ADR-0082) |
| send | `ch <- value` | left side `chan T`; value converts to `T` | statement | `Gsharp.Extensions.Go` (ADR-0082) |

Per ADR-0082 (issue #722, channel surface) and ADR-0083 (issue #723, built-in surface), every intrinsic above requires `import Gsharp.Extensions.Go` in the same compilation unit. The binder emits `GS0317` for `len`, `cap`, `append`, and `delete` without the import — the message names the .NET-idiomatic alternative (`.Length`, `.Count`, `.Remove(k)`, `List[T].Add`) when one exists. The channel-cluster intrinsics (`close`, `make(chan T)`, `<-`, `select`) report `GS0316` from the same root cause; a single `import Gsharp.Extensions.Go` unlocks both clusters.

`make` is currently special-cased only for channel creation; it is not a general allocator for slices or maps.

```gsharp
import Gsharp.Extensions.Go

let ch = make(chan int32, 3)
ch <- 1
close(ch)
let value = <-ch
```

## Arrays and slices

Fixed arrays use `[N]T`; slices use `[]T`. Literals use the same shape with an initializer body. Slices are backed by CLR arrays in the current implementation; `append` allocates and copies a new array.

```gsharp
import Gsharp.Extensions.Go

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))
Console.WriteLine(cap(nums))
nums = append(nums, 40)
Console.WriteLine(nums[3])
```

Arrays and slices support indexing, index assignment when mutable, `len`, and `cap`. `for i in 0 ... len(nums)` is the common indexed loop form; `for x in nums` is the canonical iteration form. (The legacy Go-style `for x := range nums` spelling was removed by ADR-0077 / issue #717.) The `len`/`cap`/`append` calls above require `import Gsharp.Extensions.Go`; without the import, the equivalent `.NET`-idiomatic code uses `nums.Length` and a mutable `List[int32]` for `Add` semantics.

## Maps

Map types are written `map[K]V` and are backed by `Dictionary<K,V>`. Map literals use key/value entries, indexing reads values, index assignment writes values, `delete` removes a key, and `len` returns the current count. Both `delete` and `len` require `import Gsharp.Extensions.Go` (ADR-0083); the .NET-idiomatic equivalents are `counts.Remove("missing")` and `counts.Count`.

```gsharp
import Gsharp.Extensions.Go

var counts = map[string]int32{"gsharp": 1}
counts["gsharp"] = counts["gsharp"] + 1
delete(counts, "missing")
Console.WriteLine(len(counts))
```

The .NET `Dictionary[K,V]` type is also usable through CLR interop when you import `System.Collections.Generic`; that surface is the BCL, not the language-defined map intrinsic.

## Sequences and iteration

`sequence[T]` is the G# type-clause spelling for `IEnumerable[T]`. Iterator functions that return a sequence can use `yield expr`. `async sequence[T]` is the spelling for `IAsyncEnumerable[T]`, and `await for` iterates async streams. Sequence APIs beyond iteration come from the BCL, such as LINQ extension methods imported from `System.Linq`.

## Functions, delegates, and closures

Function values use `(P1, P2) -> R` type clauses (ADR-0075) and function literals. Compatible function literals and method groups can convert to CLR delegate types during interop. Delegate construction and invocation are documented in [CLR interop](/docs/ref/clr-interop). The legacy `func(P1, P2) R` type-clause spelling continues to parse for one release with the `GS0303` deprecation warning.

## Console and legacy built-in functions

The curated documentation prefers .NET console APIs:

```gsharp
import System

Console.WriteLine("hello")
```

The compiler also contains legacy built-in functions `print(text string)`, `input() string`, and `rnd(max int32) int32`. They are implemented by the evaluator as console/random helpers and are not the shape used by current reference samples.
