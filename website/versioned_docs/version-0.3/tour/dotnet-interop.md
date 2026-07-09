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

func Main() {
    Console.WriteLine("Hello without import!")
}
```

Aliases use `import name = Namespace`:

```gsharp title="ImportAlias.gs"
package ImportAlias

import sys = System

func Main() {
    sys.Console.WriteLine("Hello from alias!")
}
```

A predefined primitive alias can be the receiver for static members, so `string.Empty` and `int32.MaxValue` work like their CLR names.

```gsharp title="PrimitiveAliasStaticReceiver.gs"
package Tour.Interop.PrimitiveAliasStaticReceiver

import System

func Main() {
    Console.WriteLine(string.Empty.Length)
    Console.WriteLine(int32.MaxValue)
}
```

## Static imports

Importing a type directly also exposes its static members for unqualified use, like C# `using static`.

```gsharp title="StaticImport.gs"
package Tour.Interop.StaticImport

import System
import System.Math

func Main() {
    Console.WriteLine(Sqrt(9.0))
    Console.WriteLine(PI > 3.0)
}
```

## CLR collections and generic types

Imported CLR types use G# generic brackets. Constructors, instance methods, properties, indexers, collection initializers, and `for in` over enumerable values are available through binding.

```gsharp title="ClrCollections.gs"
package Tour.Interop.ClrCollections

import System
import System.Collections.Generic

func Main() {
    var list = List[int32]{1, 2, 3}
    list.Add(4)

    for value in list {
        Console.WriteLine(value)
    }
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

func Main() {
    var n = -7
    var one = 1
    Console.WriteLine(n.Abs())
    Console.WriteLine(one.Scale(10))
}
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

func Main() {
    var list = List[int32]{1, 2, 3, 4, 5, 6}

    var evens = list.Where((x int32) -> x % 2 == 0)
    for v in evens {
        Console.WriteLine(v)
    }

    Console.WriteLine(list.Sum())
}
```

## Events and delegates

Event subscription uses `+=` and `-=`. Function literals can materialize as compatible CLR delegate types on the emit path.

```gsharp title="EventSubscription.gs"
package GSharp.Example.EventSubscription

import System

func Main() {
    var domain = AppDomain.CurrentDomain

    domain.ProcessExit += (sender Object, e EventArgs) -> {
        Console.WriteLine("would only fire if not removed")
    }

    Console.WriteLine("subscribed")
}
```

## Nullable imported references

Unannotated imported reference types are treated as nullable by default, and annotated nullable BCL returns stay nullable. Coalesce or check them before returning a non-null value.

```gsharp title="NullableImports.gs"
package Tour.Interop.NullableImports

func Display(value object) string {
    return value.ToString() ?? ""
}
```

## Idiomatic helpers — `Gsharp.Extensions`

The SDK bundles a `Gsharp.Extensions` assembly with opt-in helper namespaces. Imports are always explicit — nothing under `Gsharp.Extensions.*` is auto-imported.

`Optional` adds `Map` / `FlatMap` / `OrElse` / `OrCompute` / `OrThrow` / `IfPresent` / `Filter` over `T?`. `Sequences` adds builders and transformers. See the [standard-library reference](/docs/ref/standard-library) for the full surface.

Use emitted builds for delegate-heavy interop. The interpreter can evaluate many imported members by reflection, but it cannot marshal every G# function literal into a CLR delegate the same way an emitted assembly can.

## Unsafe pointers

Inside an `unsafe` function, `*T` is an unmanaged pointer. You can take addresses, dereference, and pass raw pointers to native-shaped APIs.

```gsharp title="UnsafePointers.gs"
package Tour.Interop.UnsafePointers

unsafe func Increment(p *int32) {
    *p = *p + 1
}

unsafe func Demo() int32 {
    var value = 41
    Increment(&value)
    return value
}
```

## Native interop (`@DllImport` / `@LibraryImport`)

G# also speaks the unmanaged CLR boundary. A `func` declaration whose body is the single token `;` and which carries an `@DllImport(...)` or `@LibraryImport(...)` annotation is bound as a P/Invoke stub and emitted as a CLR `PinvokeImpl` method. No `extern` keyword is needed.

```gsharp title="NativeInterop.gs"
package Tour.Interop.NativeInterop

import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func StrLenDll(text string) nint;

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
func StrLenLib(text string) nuint;

func Demo() {
    Console.WriteLine(StrLenDll("Hello, world!"))
    Console.WriteLine(StrLenLib("Hello, world!"))
}
```

Pick `@DllImport` for the smallest declaration, or `@LibraryImport` when you want an AOT-friendly explicit stub. The marshalling table includes primitives, `nint`/`nuint`, `string`, raw pointers (`*T`), slices of primitives, blittable structs/classes with `@StructLayout`, and `ref` / `out` / `in` parameters with blittable pointees.

```gsharp title="NativeByRef.gs"
package Tour.Interop.NativeByRef

import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func NativeTime(ref t int64) int64;

func Demo() {
    var now = 0L
    var rc = NativeTime(ref now)
    Console.WriteLine(rc == now)
}
```

Function-pointer parameters and returns are also supported — pass a managed callback as a delegate annotated with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)`, or declare the slot as a raw `unmanaged[Cdecl] (T) -> R` function pointer:

```gsharp title="NativeFunctionPointers.gs"
package Tour.Interop.NativeFunctionPointers

import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Comparer = delegate func(a nint, b nint) int32

@DllImport("libc", EntryPoint: "qsort")
func NativeQsort(base nint, nmemb nint, size nint, cmp Comparer) void;
```

Per-parameter `@MarshalAs(UnmanagedType.…)` overrides let you opt into a different unmanaged form — typically a Windows Unicode entry point, a modern UTF-8 C API, or a C function that takes an `int`-sized boolean flag:

```gsharp title="MarshalAs.gs"
package Tour.Interop.MarshalAs

import System.Runtime.InteropServices

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
