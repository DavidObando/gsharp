---
title: "Go-style built-ins"
sidebar_position: 2
draft: false
---

# Go-style built-ins

`Gsharp.Extensions.Go` also surfaces the small set of Go-style built-in
functions — `len`, `cap`, `append`, and `delete` — that work uniformly
across arrays, slices, strings, and maps. Outside this extension namespace
the .NET-idiomatic spelling is preferred (`.Length`, `.Count`,
`List[T].Add`, `Dictionary[K,V].Remove`); the built-ins are available
when a Go-shaped codebase wants them.

:::note Requires `import Gsharp.Extensions.Go`
The built-ins are gated behind a per-file `import Gsharp.Extensions.Go`.
Without the import, the binder emits
[`GS0317`](../ref/diagnostics#go-style-built-ins-require-import-gsharpextensionsgo-gs0317)
for each use; the message names the .NET-idiomatic alternative
(`.Length`, `.Count`, `.Remove(k)`, `List[T].Add`) when one exists.
:::

## Length and capacity — `len` / `cap`

`len(x)` returns the count of elements (or characters, for strings) and
`cap(x)` returns the underlying capacity for slice-shaped values.

```gsharp
import System
import Gsharp.Extensions.Go

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))   // 3
Console.WriteLine(cap(nums))   // 3
Console.WriteLine(len("hello")) // 5
```

The .NET-idiomatic spelling without the extension import is
`nums.Length`, `"hello".Length`, and so on. Maps spell their count as
`.Count`.

## Append — `append`

`append(slice, value)` returns a new `[]T` containing the appended
value. The first argument must be `[]T`; the second converts to `T`.

```gsharp
import System
import Gsharp.Extensions.Go

var nums = []int32{1, 2, 3}
nums = append(nums, 4)
Console.WriteLine(nums[3])   // 4
```

For mutable, grow-and-copy semantics the .NET-idiomatic alternative is
`List[T]` plus `.Add`.

## Delete — `delete`

`delete(map, key)` removes a key from a map.

```gsharp
import System
import Gsharp.Extensions.Go

var counts = map[string,int32]{"a": 1, "b": 2}
delete(counts, "a")
Console.WriteLine(len(counts))  // 1
```

The .NET-idiomatic alternative is `Dictionary[K,V].Remove(key)`.

## See also

- [Go-flavored concurrency](go-concurrency) — `go`, `chan T`, `select`,
  `close`, and `make(chan T, ...)`.
- [Standard library reference](../ref/standard-library) for the full
  built-in matrix.
