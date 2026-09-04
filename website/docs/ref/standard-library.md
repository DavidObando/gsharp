---
title: "Standard library and built-ins"
sidebar_position: 2
draft: false
---

# Standard library and built-ins

G# deliberately keeps its language-defined library small. Primitive types, collection intrinsics, channels, and function values are provided by the compiler. Most everyday library APIs are the .NET Base Class Library reached through imports and CLR interop; for example, printing in samples normally uses `Console.WriteLine` from the implicit or explicit `System` import. See [CLR interop](/docs/ref/clr-interop) for constructors, members, delegates, events, generics, attributes, and other .NET surface.

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

## Intrinsic operations

Channel operations are recognized specially by the binder; they are language syntax, not methods imported from the BCL, and they need no import (ADR-0174).

| Operation | Form | Operands | Result |
| --- | --- | --- | --- |
| construct | `chan[T]()`, `chan[T](capacity)`, `Chan.Unbounded[T]()` | rendezvous (capacity 0), buffered, unbounded | `Chan[T]`, which is a `chan[T]` |
| receive | `<-ch` | `chan[T]` or `in chan[T]` | next `T`, or `T`'s zero value once the channel is closed and drained |
| two-value receive | `let (v, ok) = <-ch`, `v, ok = <-ch` | `chan[T]` or `in chan[T]` | the element and whether the channel delivered it |
| send | `ch <- value` | `chan[T]` or `out chan[T]`; value converts to `T` | statement |
| drain | `for v in ch { … }`, `while let v = <-ch { … }` | `chan[T]` or `in chan[T]` | loops until the channel is closed |
| close | `ch.Close()` | `chan[T]` or `out chan[T]` | member call; closing twice throws, `Dispose()` is idempotent |
| `select` | `select { case … }` | channel operations | runs the first ready case |

The Go-style built-in functions `len`, `cap`, `append`, `delete`, `close(ch)`, and `make(chan T)` are **retired** (ADR-0174 D12/D13). A call reports `GS0566` naming the member replacement for the site — `xs.Length`, `m.Count`, `m.Remove(k)`, `ch.Length()`, `ch.Capacity`, `ch.Close()`, `chan[T](n)` — and a user-defined function of the same name is an ordinary call. See [Go-style built-ins (retired)](../extensions/go-builtins) for the full table.

```gsharp
let ch = chan[int32](3)
ch <- 1
ch.Close()
let value = <-ch
let (after, ok) = <-ch   // 0, false
```

## Arrays and slices

Fixed arrays use `[N]T`; slices use `[]T`. Literals use the same shape with an initializer body. A slice **is** a CLR array (`[]T` is `T[]`), so its length is `.Length` and there is no separate capacity; the growable shape is `List[T]` with `Add`.

```gsharp
import System.Collections.Generic

var nums = []int32{10, 20, 30}
Console.WriteLine(nums.Length)
var grown = List[int32]()
grown.Add(40)
Console.WriteLine(grown[0])
```

Arrays and slices support indexing, index assignment when mutable, and `.Length`. `for i in 0 ... nums.Length` is the common indexed loop form; `for x in nums` is the canonical iteration form. The legacy Go-style `for x := range nums` spelling is not supported.

## Maps

Map types are written `map[K,V]` and are backed by `Dictionary<K,V>` — the type **is** `Dictionary[K,V]`, so `.Remove(k)` removes a key and `.Count` is the current entry count. Map literals use key/value entries, indexing reads values, and index assignment writes values.

```gsharp
var counts = map[string,int32]{"gsharp": 1}
counts["gsharp"] = counts["gsharp"] + 1
counts.Remove("missing")
Console.WriteLine(counts.Count)
```

The .NET `Dictionary[K,V]` type is also usable through CLR interop when you import `System.Collections.Generic`; that surface is the BCL, not the language-defined map intrinsic.

Maps are **not goroutine-safe**: `map[K,V]` carries no implicit synchronization, and concurrent access from multiple goroutines is undefined behavior — the same posture as Go maps. For a map that is meant to be shared across goroutines, use [`SyncMap[K, V]`](#gsharpextensionssync) from `Gsharp.Extensions.Sync`.

## Sequences and iteration

`sequence[T]` is the G# type-clause spelling for `IEnumerable[T]`. Iterator functions that return a sequence can use `yield expr`. `async sequence[T]` is the spelling for `IAsyncEnumerable[T]`, and `await for` iterates async streams. Sequence APIs beyond iteration come from the BCL, such as LINQ extension methods imported from `System.Linq`.

## Gsharp.Extensions

The `Gsharp.Extensions` assembly ships with `Gsharp.NET.Sdk` and is referenced by every G# project automatically. It is the idiomatic helper layer over the BCL. Imports are always explicit — nothing under `Gsharp.Extensions.*` is auto-imported, even with the implicit-imports compiler option enabled. The assembly is organised by capability:

- `Gsharp.Extensions.Optional` — extension methods on `T?` for projection, fallback, side-effects, and filtering.
- `Gsharp.Extensions.Sequences` — static builders and extension transformers over `sequence[T]`.
- `Gsharp.Extensions.Sync` — synchronization helpers for state shared across goroutines; currently `SyncMap[K, V]`.

### Gsharp.Extensions.Optional

Extensions on `T?` for both reference-typed (`T : class`) and value-typed (`T : struct`) receivers. Each helper has two overloads with disjoint generic constraints; the G# binder picks the right one based on the receiver type.

| Symbol | Form | One-line description |
| --- | --- | --- |
| `Map` | `func [T, U] (self T?) Map(f (T) -> U) U?` | Apply `f` to the present value; pass `null` through unchanged. |
| `FlatMap` | `func [T, U] (self T?) FlatMap(f (T) -> U?) U?` | Chain a projection that itself returns a `U?`, flattening the result. |
| `OrElse` | `func [T] (self T?) OrElse(default T) T` | Return the present value or the eager fallback `default`. |
| `OrCompute` | `func [T] (self T?) OrCompute(default () -> T) T` | Return the present value or invoke `default()` lazily for the fallback. |
| `OrThrow` | `func [T] (self T?) OrThrow(message string) T` | Return the present value or throw `InvalidOperationException(message)`. |
| `IfPresent` | `func [T] (self T?) IfPresent(action (T) -> void)` | Invoke `action` only when the value is present; no-op otherwise. |
| `Filter` | `func [T] (self T?) Filter(pred (T) -> bool) T?` | Keep the value when `pred(value)` is true; otherwise yield `null`. |

Each helper carries both a `where T : class` and a `where T : struct` overload, so the same names apply to reference- and value-typed `T?`. The G# binder picks the right overload based on the receiver's shape; this follows the constraint-aware overload-resolution rule.

`Map`, `FlatMap`, `OrElse`, `OrCompute`, `IfPresent`, and `Filter` (every overload) carry `[MethodImpl(MethodImplOptions.AggressiveInlining)]` so the JIT inlines them across the assembly boundary. `OrThrow` is intentionally **not** inlined so the failure site is preserved in stack traces.

### Gsharp.Extensions.Sequences

Static builders on `Sequences`:

| Symbol | Form | One-line description |
| --- | --- | --- |
| `Range` | `func Range(start int32, count int32) sequence[int32]` | Lazy contiguous range `[start, start + count)`. |
| `RangeStep` | `func RangeStep(start int32, end int32, step int32) sequence[int32]` | Lazy strided range stopping before `end`; `step` must be non-zero (negative for descending ranges). |
| `Iterate` | `func Iterate[T](seed T, next (T) -> T) sequence[T]` | Infinite sequence `seed, next(seed), next(next(seed)), …` — pair with `Take(N)` to bound. |
| `Repeat` | `func Repeat[T](value T) sequence[T]` | Infinite sequence of `value` — pair with `Take(N)` to bound. |
| `Of` | `func Of[T](values ...T) sequence[T]` | Wrap a `params` array as a sequence. |
| `Empty` | `func Empty[T]() sequence[T]` | The empty sequence, allocation-free. |

Extension transformers on `sequence[T]`:

| Symbol | Form | One-line description |
| --- | --- | --- |
| `Windowed` | `func [T] (self sequence[T]) Windowed(size int32) sequence[[]T]` | Sliding windows of length `size` (stride 1). Empty when source is shorter than `size`. |
| `Chunked` | `func [T] (self sequence[T]) Chunked(size int32) sequence[[]T]` | Non-overlapping chunks of `size`; the trailing chunk may be shorter. |
| `Indexed` | `func [T] (self sequence[T]) Indexed() sequence[(int32, T)]` | Pair every element with its zero-based index. |
| `Pairwise` | `func [T] (self sequence[T]) Pairwise() sequence[(T, T)]` | Yield adjacent pairs `(s0, s1), (s1, s2), …`. Empty when source has fewer than two elements. |
| `Interleave` | `func [T] (self sequence[T]) Interleave(other sequence[T]) sequence[T]` | Round-robin the two sequences; trailing elements of the longer sequence flush at the end. |

Safe terminals:

| Symbol | Form | One-line description |
| --- | --- | --- |
| `FirstOrNil` | `func [T] (self sequence[T]) FirstOrNil() T?` (both `T : class` and `T : struct`) | First element or `null` if empty. Both reference- and value-typed overloads share the name; the binder picks the right one. |
| `LastOrNil` | `func [T] (self sequence[T]) LastOrNil() T?` (both `T : class` and `T : struct`) | Last element or `null` if empty. |
| `SingleOrNil` | `func [T] (self sequence[T]) SingleOrNil() T?` (both `T : class` and `T : struct`) | Single element, or `null` if empty or many. |

G#-shaped collectors:

| Symbol | Form | One-line description |
| --- | --- | --- |
| `ToSlice` | `func [T] (self sequence[T]) ToSlice() []T` | Materialise the sequence into a G# slice (`T[]` under the hood). |
| `ToMap` (tuple form) | `func [K, V] (self sequence[(K, V)]) ToMap() map[K,V]` | Build a map from a sequence of key/value tuples. Throws on duplicate keys. |
| `ToMap` (selector form) | `func [T, K, V] (self sequence[T]) ToMap(keyFn (T) -> K, valueFn (T) -> V) map[K,V]` | Project each element to a `(K, V)` pair, then build the map. |

`FirstOrNil` / `LastOrNil` / `SingleOrNil` (plus the `*ValueOrNil` companions), `Indexed`, `Of`, and `Empty` carry `[MethodImpl(MethodImplOptions.AggressiveInlining)]`. The iterator-block transformers (`Windowed`, `Chunked`, `Pairwise`, `Interleave`, `Range`, `RangeStep`, `Iterate`, `Repeat`) are intentionally **not** inlined — their bodies are compiler-generated state machines that the JIT does not inline.

### Gsharp.Extensions.Sync

Synchronization helpers for state shared across goroutines. The first type is `SyncMap[K, V]`, G#'s analog of Go's `sync.Map`: a goroutine-safe map with a method-based API — deliberately no literal or index syntax, because `m[k] = m[k] + 1` on a shared map looks atomic and races. Reads and enumeration are lock-free on a private concurrent backing store; writes serialize on a hidden monitor so `Update` is an atomic read-modify-write.

```gsharp
import Gsharp.Extensions.Sync

var m = SyncMap[string, int32]()
m.Store("hits", 1)
m.Update("hits", func(v int32) int32 { return v + 1 })   // atomic; returns 2
Console.WriteLine(m.Load("hits"))
```

| Symbol | Form | One-line description |
| --- | --- | --- |
| `SyncMap` | `SyncMap[K, V]()` | Construct an empty goroutine-safe map. |
| `Store` | `func Store(key K, value V)` | Set `key` to `value`, replacing any existing entry. |
| `Load` | `func Load(key K) V` | Read `key`; returns `V`'s zero value when absent (map-read parity). Lock-free. |
| `Update` | `func Update(key K, f (V) -> V) V` | Atomically replace the value with `f(current)` (`current` is the zero value when absent); returns the stored result. Atomic against all other writes. |
| `Delete` | `func Delete(key K) bool` | Remove the entry; reports whether one was present. |
| `Length` | `func Length() int32` | Entry count. Lock-free snapshot. |
| `Contains` | `func Contains(key K) bool` | Membership test. Lock-free. |
| `Keys` | `func Keys() []K` | Snapshot slice of the keys. Safe under concurrent writes. |
| `Range` | `func Range(action (K, V) -> void)` | Invoke `action` per entry; safe under concurrent writes, and `action` may itself write to the map (the monitor is not held). |

`Load`, `Length`, and `Contains` carry `[MethodImpl(MethodImplOptions.AggressiveInlining)]`. `Update` runs `f` while the internal write monitor is held — keep it small and non-blocking. Plain `map[K,V]` deliberately carries none of these guarantees; see [Maps](#maps).

## Functions, delegates, and closures

Function values use `(P1, P2) -> R` type clauses and function literals. Compatible function literals and method groups can convert to CLR delegate types during interop. Delegate construction and invocation are documented in [CLR interop](/docs/ref/clr-interop). The legacy `func(P1, P2) R` type-clause spelling continues to parse for one release with the `GS0303` deprecation warning.

## Console

Console input and output use the .NET console APIs:

```gsharp
import System

Console.WriteLine("hello")
```

The legacy built-in functions `print(text string)`, `input() string`, and `rnd(max int32) int32` were retired; `System.Console` (and `System.Random`) via CLR interop are the supported replacements.
