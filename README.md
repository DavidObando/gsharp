<div align="center">

<img src="assets/gsharp-icon.svg?raw=true" alt="G# logo" width="160" />

# G#

**A modern, simple, and accessible programming language for .NET.**

Kotlin- and Swift-style semantics, Go- and Python-inspired syntax — on the CLR you already know.

[![build](https://github.com/DavidObando/gsharp/actions/workflows/build.yml/badge.svg)](https://github.com/DavidObando/gsharp/actions/workflows/build.yml)
[![quality dashboard](https://github.com/DavidObando/gsharp/actions/workflows/pages.yml/badge.svg)](https://davidobando.github.io/gsharp/docs/next/project/quality-dashboard)
[![NuGet](https://img.shields.io/nuget/v/Gsharp.NET.Sdk.svg?label=Gsharp.NET.Sdk)](https://www.nuget.org/packages/Gsharp.NET.Sdk/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Documentation](https://davidobando.github.io/gsharp/) ·
[A Tour of G#](https://davidobando.github.io/gsharp/docs/tour/) ·
[Getting started](#getting-started) ·
[Editor support](#editor-support) ·
[Contributing](#contributing)

</div>

---

```gsharp
package hello

import System

data class Point(X int32, Y int32)

func describe(p Point?) string {
    if let q = p {
        return "point at (${q.X}, ${q.Y})"
    }
    return "nowhere"
}

let origin = Point(0, 0)
let moved = origin with { X = 3 }

Console.WriteLine(describe(moved))       // point at (3, 0)
Console.WriteLine(moved == Point(3, 0))  // True — structural equality
Console.WriteLine(describe(nil))         // nowhere
```

Every sample in this README compiles and runs with the current compiler.

## Why G#?

- **Small, predictable syntax.** Type-after-name declarations, no semicolons,
  no ceremony. Top-level statements are the entry point; a one-file program is
  a real program.
- **Null safety by design.** `T?` is a distinct type. `if let`, `guard let`,
  `while let`, `?.`, and `??` make the absent case explicit — the compiler
  won't let you forget it.
- **Data modeling that pulls its weight.** `data class` / `data struct` give
  you structural equality, `with`-copy, and deconstruction from a single line.
- **Structured concurrency.** `chan`, `go`, and `scope { }` blocks bring
  Go-style channels and goroutine-shaped tasks to .NET, with child work joined
  and failures observed before control leaves the scope.
- **The whole .NET ecosystem.** Every BCL type, every NuGet package, LINQ,
  P/Invoke, events — callable directly, no bindings or wrappers. G# assemblies
  are ordinary .NET assemblies consumable from C# and F#.
- **First-class tooling.** An MSBuild SDK (`dotnet build`/`run`/`pack` just
  work), a language server with VS Code and Visual Studio extensions, a REPL,
  code analyzers, and a C#→G# migration tool.

## Getting started

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download). Then:

```sh
dotnet new install Gsharp.Templates
dotnet new gsharp-console -n MyApp
cd MyApp && dotnet run
# Hello from GSharp!
```

A `.gsproj` is a regular SDK-style .NET project that happens to compile
`.gs` files:

```xml
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
</Project>
```

Templates for libraries, xUnit test projects, and web apps ship in the same
package: `gsharp-lib`, `gsharp-xunit`, `gsharp-web`.

## A taste of G#

### Channels and structured concurrency

```gsharp
package pipeline

import System

func produce(ch out chan[int32]) int32 {
    for var n = 1; n <= 3; n = n + 1 {
        ch <- n * 10
    }
    return 0
}

let ch = chan[int32](3)

scope {
    go produce(ch)

    for var i = 0; i < 3; i = i + 1 {
        Console.WriteLine("got ${<-ch}")
    }
}

Console.WriteLine("pipeline drained")
```

`scope { }` guarantees the goroutines it spawns finish (and surface their
failures) before the block exits. See the
[concurrency guide](https://davidobando.github.io/gsharp/docs/extensions/go-concurrency)
for `select`-style patterns, buffered channels, and `close` semantics.

### Seamless .NET interop

```gsharp
package interop

import System
import System.Collections.Generic
import System.Linq

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)

let doubled = nums.Select((x int32) -> x * 2).Sum()
Console.WriteLine("sum of doubles: $doubled")   // 12
```

CLR generics use G#'s bracket spelling (`List[int32]`), lambdas flow into
LINQ, and `@DllImport` functions bind as P/Invoke stubs. The full story —
events, delegates, ref/out, function pointers, struct marshalling — is in the
[CLR interop reference](https://davidobando.github.io/gsharp/docs/ref/clr-interop).

Want more? The [Tour of G#](https://davidobando.github.io/gsharp/docs/tour/)
walks through pattern matching, interfaces, extension functions, error
handling, generics, and the rest of the language.

## Editor support

<table>
<tr><td><b>VS Code</b></td><td>

[`gsharplang.vscode-gsharp`](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp)
— syntax highlighting, completion, hover, diagnostics, formatting, build/run
commands, and debugging. `code --install-extension gsharplang.vscode-gsharp`

</td></tr>
<tr><td><b>Visual&nbsp;Studio</b></td><td>

The [G# extension for Visual Studio 2022/2026](src/vs-gsharp/README.md) adds
native projects, NuGet, managed debugging, Test Explorer, templates, and six
G# themes on top of the same language server.

</td></tr>
<tr><td><b>REPL</b></td><td>

`dotnet tool install --global Gsharp.Repl` gives you `gsi`, an interactive
REPL and `.gs` file runner.

</td></tr>
</table>

## Tooling

| Tool | What it does |
| --- | --- |
| [`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/) | MSBuild SDK — `dotnet build`, `run`, `test`, and `pack` for `.gsproj` projects, including Roslyn source-generator hosting and code analyzers. |
| [`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/) | `dotnet new` templates: console, library, xUnit, web. |
| [`Gsharp.Repl`](https://www.nuget.org/packages/Gsharp.Repl/) | `gsi` — interactive REPL and file runner. |
| [`Gsharp.Gsfmt`](https://www.nuget.org/packages/Gsharp.Gsfmt/) | `gsfmt` — the option-free canonical G# formatter used by editors, CI, the SDK, and `cs2gs`. |
| [`Gsharp.Cs2Gs`](https://www.nuget.org/packages/Gsharp.Cs2Gs/) | `cs2gs` — migrates C# projects to G#, including Roslyn analyzers and their tests. |

`cs2gs` doubles as the compiler's quality gate: every C# syntax construct is
classified in a machine-checked coverage inventory, a per-construct
conformance corpus is translated, compiled, IL-verified, and byte-compared
against its C# baseline on every PR, and newly discovered gaps are
automatically filed as issues (see [`tools/cs2gs/README.md`](tools/cs2gs/README.md)).

## Documentation

The [documentation site](https://davidobando.github.io/gsharp/) hosts the
language tour, tutorials, the language guide, the specification, and the
tooling reference; its source lives in [`website/`](website/). Design history
is recorded as [Architecture Decision Records](docs/adr/).

## Repository layout

```
src/
  Core/               # Compiler front-end: syntax, binder, lowering, symbols, emit
  Compiler/           # gsc — command-line compiler driver
  Formatting/         # GSharp.Formatting library and gsfmt CLI
  Repl/               # gsi — interactive REPL
  LanguageServer/     # LSP server backing the editor experience
  Sdk/                # MSBuild SDK, templates, and Gsharp.Extensions
  vs-gsharp/          # Visual Studio extension
tools/cs2gs/          # C# → G# migration tool and conformance corpus
e2etests/             # End-to-end smoke tests
test/                 # xUnit suites covering the compiler, SDK, and tooling
website/              # Docusaurus documentation site
```

## Contributing

Contributions are welcome — read [`CONTRIBUTING.md`](CONTRIBUTING.md) for
build, test, and pull-request guidance. Compatibility commitments are
documented in
[`docs/compatibility-and-stability.md`](docs/compatibility-and-stability.md),
and vulnerabilities can be reported privately through
[`SECURITY.md`](SECURITY.md).

## License

G# is open source under the [MIT license](LICENSE).
