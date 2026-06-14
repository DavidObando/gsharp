---
title: "Tour: .NET interop"
sidebar_position: 6
draft: false
---

# Tour: .NET interop

G# targets the CLR, so importing and using .NET APIs is part of the language's core workflow. Imports can bring CLR namespaces into scope, aliases can shorten names, and emitted assemblies use normal .NET metadata.

## Imports and aliases

The compiler implicitly imports `System` by default, so `Console` is available in simple programs. You can disable that with `/noimplicitimports` and write imports explicitly.

```gsharp title="ImplicitImport.gs"
package ImplicitImport

Console.WriteLine("Hello without import!")
```

```text
Hello without import!
```

Aliases use `import name = Namespace`:

```gsharp title="ImportAlias.gs"
package ImportAlias

import sys = System

sys.Console.WriteLine("Hello from alias!")
```

```text
Hello from alias!
```

## CLR collections and generic types

Imported CLR types use G# generic brackets. Constructors, instance methods, properties, indexers, and `for in` over enumerable values are available through binding.

```gsharp
package Tour.Interop

import System
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)

for value in list {
    Console.WriteLine(value)
}
```

## Extension functions

G# extension functions use a Go-style receiver clause. They are called with instance syntax.

```gsharp title="ExtensionFunctions.gs"
package GSharp.Example.ExtensionFunctions

import System

func (value int32) Abs() int32 {
    if value < 0 {
        return -value
    }

    return value
}

func (value int32) Scale(factor int32) int32 {
    return value * factor
}

var n = -7
var one = 1
Console.WriteLine(n.Abs())
Console.WriteLine(one.Scale(10))
```

```text
7
10
```

G# can also call imported CLR extension methods with receiver syntax. LINQ methods are a good example:

```gsharp title="LinqExtensions.gs"
package GSharp.Example.LinqExtensions

import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)
list.Add(5)
list.Add(6)

var evens = list.Where((x int32) -> x % 2 == 0)
for v in evens {
    Console.WriteLine(v)
}

Console.WriteLine(list.Sum())
```

```text
2
4
6
21
```

## Events and delegates

Event subscription uses `+=` and `-=`. Function literals can materialize as compatible CLR delegate types on the emit path.

```gsharp title="EventSubscription.gs"
package GSharp.Example.EventSubscription

import System

var domain = AppDomain.CurrentDomain

domain.ProcessExit += (sender Object, e EventArgs) -> {
    Console.WriteLine("would only fire if not removed")
}

Console.WriteLine("subscribed")
```

```text
subscribed
would only fire if not removed
```

## Idiomatic helpers — `Gsharp.Extensions`

The SDK bundles a `Gsharp.Extensions` assembly with opt-in helper namespaces. Imports are always explicit — nothing under `Gsharp.Extensions.*` is auto-imported.

```gsharp title="Optional and Sequences"
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

let name string? = "ada"
let upper = name.Map((s string) -> s.ToUpper())

for trio in Sequences.Range(1, 6).Windowed(3) {
    Console.WriteLine(String.Join(",", trio))
}
```

`Optional` adds `Map` / `FlatMap` / `OrElse` / `OrCompute` / `OrThrow` / `IfPresent` / `Filter` over `T?`. `Sequences` adds builders (`Range`, `RangeStep`, `Iterate`, `Repeat`, `Of`, `Empty`), transformers (`Windowed`, `Chunked`, `Indexed`, `Pairwise`, `Interleave`), safe terminals (`FirstOrNil` and friends), and G#-shaped collectors (`ToSlice`, `ToMap`). See the [standard-library reference](/docs/ref/standard-library) for the full surface. The Go-flavored extension layer is documented in [Extensions: Go-flavored concurrency](../extensions/go-concurrency) and [Extensions: Go-style built-ins](../extensions/go-builtins).

Use emitted builds for delegate-heavy interop. The interpreter can evaluate many imported members by reflection, but it cannot marshal every G# function literal into a CLR delegate the same way an emitted assembly can.

## Native interop (`@DllImport` / `@LibraryImport`)

G# also speaks the unmanaged CLR boundary. A `func` declaration whose body is the single token `;` and which carries an `@DllImport(...)` or `@LibraryImport(...)` annotation is bound as a P/Invoke stub and emitted as a CLR `PinvokeImpl` method. No `extern` keyword is needed.

```gsharp
import System
import System.Runtime.InteropServices

// Classic runtime-marshalled P/Invoke.
@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func StrLenDll(text string) nint;

// Source-generator-shaped P/Invoke with an explicit IL stub.
// AOT-friendly: the compiler emits the marshalling wrapper inline,
// so the runtime never auto-marshals strings at the boundary.
@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func StrLenLib(text string) nuint;

Console.WriteLine(StrLenDll("Hello, world!"))   // 13
Console.WriteLine(StrLenLib("Hello, world!"))   // 13
```

Pick `@DllImport` for the smallest possible declaration (the runtime handles marshalling), or `@LibraryImport` when you want an AOT-friendly explicit stub. Either way the v1 marshalling table is the same: primitives, `nint`/`nuint`, `string`, `*T` byref-style pointers (`T` primitive), and slices of primitives. Blittable structs and classes are also marshalled when annotated with `@StructLayout(LayoutKind.Sequential|Explicit)`, and `ref` / `out` / `in` parameters with a blittable pointee are accepted on both attribute forms:

```gs
@DllImport("libc", EntryPoint: "time")
func NativeTime(ref t int64) int64;

var now = 0L
var rc = NativeTime(ref now)
Console.WriteLine(rc == now)   // True
```

The runtime marshals the byref slot as `T*` to the unmanaged callee, which is the canonical shape for libc APIs that write a result through an out-pointer (`time`, `clock_gettime`, `pipe`). Function-pointer parameters and returns are also supported — pass a managed callback as a delegate annotated with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)`, or declare the slot as a raw `unmanaged[Cdecl] (T) -> R` function pointer:

```gs
@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Comparer = delegate func(a nint, b nint) int32

@DllImport("libc", EntryPoint: "qsort")
func NativeQsort(base nint, nmemb nint, size nint, cmp Comparer) void;
```

Per-parameter `@MarshalAs(UnmanagedType.…)` overrides let you opt into a different unmanaged form — typically a Windows `…W` Unicode entry-point, a modern UTF-8 C API, or a C function that takes an `int`-sized boolean flag:

```gs
@DllImport("user32", EntryPoint: "MessageBoxW")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;

@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
```

See the [native-interop section of the CLR interop reference](../ref/clr-interop.md#unmanaged-interop-pinvoke) for the full attribute surface and diagnostics.

Next: [Tutorials](/docs/tutorials/getting-started), or go deeper with the [CLR interop reference](/docs/ref/clr-interop).
