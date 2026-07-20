# G#

A modern, simple, and accessible programming language for .NET.

G# brings Go-, Kotlin-, and Swift-style ergonomics to the CLR. The
syntax stays small and predictable; the runtime is the same .NET you
already know, so every BCL type, NuGet package, and `dotnet` tool works
out of the box.

[![build](https://github.com/DavidObando/gsharp/actions/workflows/build.yml/badge.svg)](https://github.com/DavidObando/gsharp/actions/workflows/build.yml)

📖 **Documentation:** https://davidobando.github.io/gsharp/ — language
tour, tutorials, specification, and tooling reference. The site source
lives in [`website/`](website/).

![](assets/gsharp-icon.svg?raw=true)

## A taste of G#

A short tour of v0.2 idioms — the same ones the documentation site uses.

### Data classes with `with`-copy and deconstruction

```gsharp
package GSharp.Tour.DataClass

import System

data class Person(Name string, Age int32)

let alice = Person("Alice", 30)
let older = alice with { Age = 31 }
let (n, a) = older

Console.WriteLine("$n is $a")           // Alice is 31
Console.WriteLine(alice == older)       // False — different Age
Console.WriteLine(alice == Person("Alice", 30))  // True — structural equality
```

`data struct` is the value-typed counterpart, with the same synthesized
equality, `with`-copy, and deconstruction.

### `if let` for nullable handling

```gsharp
package GSharp.Tour.IfLet

import System

func Greet(name string?) {
    if let n = name {
        Console.WriteLine("hi $n")
    } else {
        Console.WriteLine("hi stranger")
    }
}

Greet("Ada")
Greet(nil)
```

`guard let v = expr else { return }` is the partner form: it binds `v` for
the remainder of the enclosing block when the value is non-nil, and the
`else` branch must unconditionally exit.

### Sequences from `Gsharp.Extensions.Sequences`

```gsharp
package GSharp.Tour.Sequences

import System
import Gsharp.Extensions.Sequences

for pair in Sequences.Range(1, 5).Indexed() {
    Console.WriteLine("${pair.Item1}: ${pair.Item2}")
}

for trio in Sequences.Range(1, 6).Windowed(3) {
    Console.WriteLine(String.Join(",", trio))
}
```

`Sequences` ships builders (`Range`, `RangeStep`, `Iterate`, `Repeat`,
`Of`, `Empty`), transformers (`Indexed`, `Windowed`, `Chunked`,
`Pairwise`, `Interleave`), safe terminals (`FirstOrNil`, `LastOrNil`,
`SingleOrNil`), and G#-shaped collectors (`ToSlice`, `ToMap`).

### Optional helpers — `Map`, `OrElse`, `Filter`

```gsharp
package GSharp.Tour.Optional

import System
import Gsharp.Extensions.Optional

let name string? = "ada"

let upper = name.Map((s string) -> s.ToUpper())
Console.WriteLine(upper ?? "<absent>")           // ADA

let absent string? = nil
Console.WriteLine(absent.OrElse("default"))      // default

let short = name.Filter((s string) -> s.Length <= 2)
Console.WriteLine(short ?? "<filtered out>")     // <filtered out>
```

### `scope` + `async` / `await`

```gsharp
package GSharp.Tour.AsyncScope

import System
import System.Threading.Tasks

async func compute(n int32) int32 {
    await Task.Delay(5)
    return n * 2
}

async func runAll() {
    let a = await compute(3)
    let b = await compute(4)
    Console.WriteLine("a = $a, b = $b")
}

scope {
    runAll().Wait()
}

Console.WriteLine("done")
```

`scope { ... }` is the structured-concurrency block: child work
registered inside the scope is joined before control leaves it, and
failures are observed instead of silently lost.

## Getting started

G# ships an MSBuild SDK ([`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/))
and a `dotnet new` template package ([`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/)),
both available on NuGet, so a `.gsproj` is just a regular .NET project
that happens to compile `.gs` files. After installing the template
package, you can scaffold and run a console app in three commands:

```sh
dotnet new install Gsharp.Templates
dotnet new gsharp-console -n MyApp
cd MyApp && dotnet build && dotnet run
# -> Hello from GSharp!
```

A minimal `.gsproj` looks like any other modern .NET project:

```xml
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
</Project>
```

The SDK is validated against `net8.0` and `net10.0`; adding additional
target frameworks is a one-line change in
[`e2etests/multitarget-e2e.sh`](e2etests/multitarget-e2e.sh).

## Editor support

The **G# VS Code extension** is published on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp).
It provides syntax highlighting, language-server features (completion,
hover, diagnostics, formatting, and more), build/run commands, and
debugger configuration for `.gs` and `.gsproj` files. Install it from
within VS Code (search for "G#") or from the command line:

```sh
code --install-extension gsharplang.vscode-gsharp
```

The repository also builds a
[G# extension for Visual Studio 2022 and Visual Studio 2026](src/vs-gsharp/README.md).
It provides the same language server and editor assets plus native CPS
projects, NuGet, managed debugging, Test Explorer, project/item templates,
snippets, and all six G# themes.

## Interoperating with .NET

Every .NET type — your packages, third-party NuGet packages, the BCL —
is callable from G# with the syntax you already know. CLR generics use
G#'s bracket spelling, and method calls, properties, indexers, and
`for in` over `IEnumerable[T]` all just work:

```gsharp
package GSharp.Tour.Interop

import System
import System.Collections.Generic
import System.Linq

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
nums.Add(4)

let evens = nums.Where((x int32) -> x % 2 == 0)
for v in evens {
    Console.WriteLine(v)
}

Console.WriteLine(nums.Sum())
```

G# also speaks the unmanaged boundary directly. A `func` declaration
whose body is `;` and that carries `@DllImport` or `@LibraryImport`
binds as a P/Invoke stub — no `extern` keyword needed:

```gsharp
package GSharp.Tour.PInvoke

import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func StrLen(text string) nint;

Console.WriteLine(StrLen("Hello, world!"))   // 13
```

The full interop story — events, delegates, ref/out parameters,
function pointers, struct marshalling — is documented in the
[CLR interop reference](https://davidobando.github.io/gsharp/docs/ref/clr-interop).

## Documentation

| Topic | Where |
| --- | --- |
| Live documentation site | https://davidobando.github.io/gsharp/ |
| A Tour of G# (start here) | [`website/docs/tour/`](website/docs/tour/) |
| Tutorials | [`website/docs/tutorials/`](website/docs/tutorials/) |
| Language guide | [`website/docs/guide/`](website/docs/guide/) |
| Language specification | [`website/docs/ref/spec.md`](website/docs/ref/spec.md) |
| Architecture Decision Records | [`docs/adr/`](docs/adr/) |
| MSBuild SDK + templates | [`docs/sdk-usage.md`](docs/sdk-usage.md) |
| Compiler architecture | [`docs/emit-pipeline.md`](docs/emit-pipeline.md) |

## .NET tools

The REPL and the C#→G# migrator ship as global .NET tools (requires a .NET 10 runtime):

```sh
dotnet tool install --global Gsharp.Repl    # `gsi` — interactive REPL / file runner
dotnet tool install --global Gsharp.Cs2Gs   # `cs2gs` — C# to G# migration tool
```

`cs2gs` doubles as the compiler's quality gate: every C# syntax construct is
classified in a machine-checked coverage inventory
([`docs/cs2gs-coverage-matrix.md`](docs/cs2gs-coverage-matrix.md)), a
per-construct conformance corpus is translated, compiled, IL-verified, and
byte-compared against its C# baseline on every PR, and newly discovered
compiler gaps are automatically filed as issues from a fingerprinted gap
ledger (see [`tools/cs2gs/README.md`](tools/cs2gs/README.md) and ADR-0138).

## Repository layout

```
src/
  Core/               # Shared front-end: syntax, binder, lowering, symbols, emit
  Compiler/           # gsc.dll command-line driver
  Repl/               # gsi.dll modern Spectre.Console TUI (REPL + language tests)
  LanguageServer/     # LSP server backing the editor experience
  Sdk/
    Gsharp.NET.Sdk/   # MSBuild SDK that wires .gsproj into dotnet build
    Gsharp.Templates/ # dotnet new template package (gsharp-console)
  Gsharp.Extensions/  # Opt-in idiomatic helpers (Optional, Sequences, Go)
samples/              # End-user fixtures referenced by docs and tests
e2etests/             # End-to-end smoke scripts: sdk-e2e, templates-e2e, multitarget-e2e
test/                 # xUnit projects covering Core, Compiler, Interpreter, LSP
website/              # Docusaurus site (source for the docs above)
```

## Contributing

Contributions are welcome. Open an issue to discuss your idea before
sending a pull request — agreeing on the shape up front keeps the
review cycle short. The [`docs/`](docs/) folder has the ADRs and design
notes that explain why specific decisions were made.
