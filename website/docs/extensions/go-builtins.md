---
title: "Go-style built-ins (retired)"
sidebar_position: 2
draft: false
description: "Replace retired Go-style built-ins with the corresponding G# and .NET members."
---

# Go-style built-ins (retired)

Early G# 0.4 packages shipped the Go-style built-in functions `len`, `cap`, `append`, and
`delete` behind a per-file `import Gsharp.Extensions.Go`. ADR-0174 (D13)
retired them, together with the import gate and the `Gsharp.Extensions.Go`
namespace itself: every receiver already carries the member, so a free
function that adds no syntax of its own only competed with it. A call to a
retired name reports
[`GS0566`](../ref/diagnostics.md#channel-operations-and-retired-spellings),
whose message names the replacement for that exact site (`xs.Length`,
`m.Count`, `m.Remove(k)`, …). The names are free for your own functions: a
user-defined `func len(...)` is an ordinary call.

<span id="length-and-capacity--len--cap"></span>
<span id="append--append"></span>
<span id="delete--delete"></span>

## Replacements

| Retired | Receiver | Write instead |
|---|---|---|
| `len(xs)` | array `[N]T`, slice `[]T`, string, rectangular array | `xs.Length` (rectangular arrays also have `.Rank` and `.GetLength(d)`) |
| `len(m)` | `map[K, V]` | `m.Count` |
| `len(ch)` | a channel you constructed (`Chan[T]`) | `ch.Length()` |
| `cap(xs)` | slice | *removed* — a slice is a fixed CLR array whose capacity **is** its length, `xs.Length` |
| `cap(ch)` | a channel you constructed | `ch.Capacity` |
| `append(xs, v)` | slice | keep a growable `List[T]` and call `.Add(v)`; a slice is a fixed CLR array |
| `delete(m, k)` | `map[K, V]` | `m.Remove(k)` |
| `close(ch)` | channel | `ch.Close()` |
| `make(chan T[, n])` | — | `chan[T]()` (rendezvous), `chan[T](n)`, `Chan.Unbounded[T]()` |

```gsharp
import System
import System.Collections.Generic

var nums = []int32{10, 20, 30}
Console.WriteLine(nums.Length)        // 3

var grown = List[int32]()
grown.Add(40)
Console.WriteLine(grown.Count)        // 1

var counts = map[string,int32]{"a": 1, "b": 2}
counts.Remove("a")
Console.WriteLine(counts.Count)       // 1

Console.WriteLine("hello".Length)     // 5
```

Because `[]T` **is** `T[]` and `map[K, V]` **is** `Dictionary[K, V]` (ADR-0158
type identity), no new API ships with this change; the members were always
there.

## See also

- [Go-flavored concurrency](go-concurrency) — `go`, `chan[T]`, `select`,
  `ch.Close()`, and channel construction.
- [Standard library reference](../ref/standard-library) for the full
  built-in matrix.
