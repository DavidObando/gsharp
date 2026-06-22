---
title: "Frequently asked questions"
draft: false
---

# Frequently asked questions

This page answers common questions about G# as it exists today. For formal details, see the [language specification](/docs/ref/spec), the [feature matrix](/docs/ref/feature-matrix), and the [design decisions index](/docs/design-decisions).

## What is G#?

G# is a modern .NET language that brings concise package, function, concurrency, and data-shape ergonomics to the CLR. It keeps a compact surface with packages, imports, `func`, structs, slices, maps, channels, `go`, `select`, and `for in` iteration, while targeting managed assemblies and interoperating with CLR libraries. The project goal is a modern, simple, accessible language that lets developers use the .NET ecosystem without writing C#.

## How does G# relate to Go?

G# borrows many ideas from Go: package-oriented source files, `func`, slices, maps, channels, `go`, `select`, `defer`, and a bias toward simple syntax. It is not Go, and it does not try to replace Go; Go skills should transfer, but G# also chooses CLR interop, .NET exceptions, nullable types, `async`/`await`, and explicit `let`/`var` where the .NET platform benefits from them.

## How does G# relate to C#.NET?

G# targets the same runtime and libraries as C# rather than defining a separate platform. It emits managed assemblies, can call CLR constructors, methods, properties, fields, events, operators, conversions, delegates, and generic types, and uses normal .NET project builds through the G# MSBuild SDK. See the [CLR interop reference](/docs/ref/clr-interop).

## What runtime does G# target?

G# targets the .NET CLR. The compiler can emit executables or libraries with managed PE metadata, optional reference assemblies, and Portable PDBs; executable output also gets a runtime configuration file. The default target framework mapping is currently `net10.0`, with compiler options for supported target frameworks such as `net8.0`, `net9.0`, and `net10.0`.

## How do I install G#?

Start with the [installation guide](/docs/getting-started/install). The project flow uses `dotnet new install Gsharp.Templates`, a `gsharp-console` template, and `.gsproj` files that use the `Gsharp.NET.Sdk` MSBuild SDK. Both [`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/) and [`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/) are published on NuGet.

## Where is the language specification?

The public specification page is [Language specification](/docs/ref/spec). It is the place to look for grammar, lexical structure, types, expressions, statements, packages, and runtime behavior as the documentation matures.

## Why use `int32` and `uint64` instead of `int` and `long`?

G# uses width-bearing fixed-size integer names such as `int8`, `uint16`, `int32`, and `uint64` so the type's size is visible in source and consistent with names like `float32` and `float64`.  replaced the earlier C#-style integer names while the language was still pre-stable; `nint` and `nuint` remain the native-width integer spellings.  /  layers ten friendly aliases (`int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, `double`) on top of the canonical names: they resolve at the binder, are interchangeable with the width-bearing spellings everywhere, and diagnostics, `typeof`, hover, and IL always print the canonical name. The canonical width-bearing spellings remain preferred in documentation and public library APIs. 
## Does G# have `null`?

G# uses `nil`, not `null`, and nullability is part of the type. A non-nullable `T` cannot receive `nil`; a nullable `T?` can. The language includes safe access `?.`, null coalescing `??`, and null assertion `!!`. This is the language nullability model.

## How is concurrency modeled?

G# combines a structured concurrency surface with .NET primitives. `go f` starts a concurrent call, `chan T` is backed by `System.Threading.Channels`, sends and receives use `<-`, and `select` chooses among channel operations. `scope` provides structured concurrency so child tasks are joined and failures propagate at the end of the scope. See [Concurrency and async](/docs/guide/concurrency-async).

## How does `async` work?

`async func` and `await` exist for direct .NET interop with `Task`, `Task[T]`, and compatible awaitable shapes. In emitted code, G# lowers async functions and lambdas to .NET state machines; in the interpreter, awaits block on the awaiter for simple test and REPL behavior. 
## How do optional parameters, named arguments, and overloading work in G# functions?

User-defined G# functions support all three:

- **Optional parameters**: declare a default value with `=` after the type — `func greet(name string = "world")`. Defaults must be compile-time constants and trailing optional parameters cannot precede required ones. Misuse reports `GS0265`.
- **Named arguments**: any call site can name an argument — `greet(name: "Ada")` — for free functions, user methods, user constructors, extension functions, and inherited CLR methods. The call-site form is `name: value`; `GS0315` identifies the older separator form. Indirect calls through a function-typed variable and variadic call sites do not accept names because the target does not preserve parameter names. Diagnostics `GS0244`–`GS0247`.
- **Overloading**: two declarations of the same function name are allowed as long as they differ by parameter types, arity, or ref-kinds. Duplicate signatures report `GS0264`; ambiguous calls report `GS0266`; no-applicable-overload reports `GS0267`.

This is a recent change — earlier docs described G# as having no parameter defaults and only "partial" named-argument support. That is no longer accurate.

## How do generics work?

G# supports generic functions and types with bracketed CLR generic syntax, such as `func Id[T any](x T) T` and `Box[int32]`. The implementation emits **reified CLR generic metadata** end-to-end: user-declared generic types/methods carry `GenericParam` rows, signatures over `T` encode `Var`/`MVar`, closed CLR generics over an in-scope type parameter (`List[T]`) emit honest `GenericInstantiation` blobs, and open-bearing delegates (`func(T) U`) dispatch through reified `Func`N::Invoke` MemberRefs. Type-argument inference is implemented for supported cases. Variance markers `in` and `out` are available where the CLR supports them, especially interfaces. 

## What is the difference between structs, classes, data structs, data classes, and inline value classes?

A `struct` is value-like, while a `class` is reference-like and can participate in class inheritance when marked `open`. A `data struct` is a value aggregate with synthesized structural equality and copy/update ergonomics; `data class` provides the reference-typed counterpart. An `inline struct` is a one-field readonly value wrapper for newtype-style modeling. 

## How do I call .NET libraries?

Import the relevant CLR namespace or reference the assembly through the compiler or SDK project, then call the .NET type members from G#. Imported constructors, overloads, properties, fields, events, delegates, extension methods, operators, conversions, generics, and optional CLR arguments are part of the interop surface. See the [CLR interop reference](/docs/ref/clr-interop).

## What is the difference between the `gsc` interpreter path and emit path?

`gsc` shares lexing, parsing, binding, and lowering between both paths. If you invoke it without `/out:`, it interprets the program in-process; if you provide `/out:`, it emits a managed executable or library, with optional PDBs and reference assemblies. The interpreter is useful for REPL-style execution and tests, while emit is the production compilation path. See the [`gsc` reference](/docs/tooling/gsc).

## Does G# have a Playground?

A Playground page exists in the documentation at [Playground](/docs/playground), but the browser execution service is deferred. Today, use the local compiler, templates, SDK projects, samples, and tests for runnable code.

## Does G# have classes and object-oriented features?

Yes. G# has classes, constructors, fields, methods, properties, events, interfaces, base classes, open and override methods, static members through `shared`, and CLR interop. The surface is intentionally smaller than C# and is designed to coexist with value-oriented structs and data structs.

## Does G# use exceptions or Go-style error returns?

G# uses CLR-style exceptions with `try`, `catch`, `finally`, and `throw`. That choice matches the .NET ecosystem and imported library behavior. Go-style multiple-return error conventions can be modeled by user code, but they are not the language's core error mechanism.

## Are slices, maps, and sequences built in?

Yes. Fixed arrays use `[N]T`, slices use `[]T`, maps use `map[K,V]`, and sequences use `sequence[T]`. Slices are backed by CLR arrays, maps by dictionary-like storage, and sequences map to .NET enumerable shapes, with iterator functions using `yield`.

## What editor and debugging support exists?

A language server and a VS Code extension support `.gs` files, plus Portable PDB support enables normal .NET/CoreCLR debugging of emitted assemblies. The VS Code extension is published on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp). See [VS Code support](/docs/tooling/vscode), [LSP support](/docs/tooling/lsp), and [Debugging](/docs/tooling/debugging).
