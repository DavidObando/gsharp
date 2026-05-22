# GSharp
GSharp Programming Language.
A modern, simple, and accessible programming language for .NET.

[![build](https://github.com/DavidObando/gsharp/actions/workflows/build.yml/badge.svg)](https://github.com/DavidObando/gsharp/actions/workflows/build.yml)

## Getting started

GSharp ships an MSBuild SDK (`Gsharp.NET.Sdk`) and a `dotnet new` template (`Gsharp.Templates`) so a `.gsproj` is just a regular .NET project that happens to compile `.gs` files. After installing the template package, you can scaffold and run a console app in three commands:

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

The SDK is validated against `net8.0` and `net10.0`; adding additional target frameworks is a one-line change in [`build/multitarget-e2e.sh`](build/multitarget-e2e.sh). See [`docs/sdk-usage.md`](docs/sdk-usage.md) for the full SDK + templates walkthrough (including how to side-load the SDK locally before it is published to a public NuGet feed) and [`docs/emit-pipeline.md`](docs/emit-pipeline.md) for the compiler architecture.

## Documentation

| Topic | Doc |
| --- | --- |
| Language design v0.2 (locked design decisions D1–D11, target syntax surface) | [`design/Gsharp-design-v0.2.md`](design/Gsharp-design-v0.2.md) |
| Language design v0.1 (top-level statements, entry-point synthesis, samples) | [`design/Gsharp-design-v0.1.md`](design/Gsharp-design-v0.1.md) |
| Architecture Decision Records (D1–D11 and every later phase) | [`docs/adr/`](docs/adr/) |
| MSBuild SDK + `dotnet new` template usage | [`docs/sdk-usage.md`](docs/sdk-usage.md) |
| Compiler architecture (syntax → bound → emit), cross-TFM, interpreter vs emit | [`docs/emit-pipeline.md`](docs/emit-pipeline.md) |

## Repository layout

```
src/
  Core/             # Shared front-end: syntax, binder, lowering, symbols, emit
  Compiler/         # gsc.dll command-line driver
  Interpreter/      # In-process evaluator (REPL + language tests)
  LanguageServer/   # LSP server backing the editor experience
  Roslyn/           # Roslyn fork, staged for future semantic-model work
  Sdk/
    Gsharp.NET.Sdk/ # MSBuild SDK that wires .gsproj into dotnet build
    Gsharp.Templates/ # dotnet new template package (gsharp-console)
samples/            # HelloWorld and other end-user fixtures
build/              # End-to-end smoke scripts: sdk-e2e, templates-e2e, multitarget-e2e
test/               # xUnit projects covering Core, Compiler, Interpreter, LSP
```

## Motivation 1: Accessibility
I want to enable other developers to benefit from the .NET framework without necessarily having to learn C#. In particular, I want to ensure new developers and developers who find C#'s learning curve a bit steep to be able to use .NET. I want VB.NET developers and Python developers to find a language that speaks to them as well. I want non-English speakers to have access to powerful libraries and technologies in .NET. In short, I want simplicity and productivity at the hand of everyone.

## Motivation 2: Simplicity
I want a simple, concise, productive programming language targetting .NET based on the good lessons learned from Go, Kotlin, as well as other programming languages. Modern languages such as Go give the user a simple approach to programming while also providing powerful foundations to deliver applications in all forms and factors.

Here's a few relevant links to bring this point home:
  - Classes versus Data Structures http://blog.cleancoder.com/uncle-bob/2019/06/16/ObjectsAndDataStructures.html
  - Why OO sucks http://www.cs.otago.ac.nz/staffpriv/ok/Joe-Hates-OO.htm
  - Why I prefer go over Java or Python https://yourbasic.org/golang/advantages-over-java-python/
  - Go is in a trajectory to become the next enterprise language https://hackernoon.com/go-is-on-a-trajectory-to-become-the-next-enterprise-programming-language-3b75d70544e

Go is also finding its way into unexpected places with projects such as TinyGo https://tinygo.org/.

Kotlin, on the other hand, is gaining popularity as a language targetting the JVM in replacement of Java. Kotlin provides a more elegant and smaller language to efficiently write code that runs on the JVM and is interoperable with Java language code. This allows developers to not have to use the Java language while still leveraging the power of the JVM and the large body of libraries available.

GSharp is born with a similar mindset to Kotlin and with a similar philosophy to Go. GSharp is intended to start small, slowly lighting up application development features such as consuming libraries written in C#, while keeping the language simple.

# Go developers?
Note that I'm not thinking about attracting current Go developers necessarily. I am a Go developer myself and I will continue using Go where it's appropriate. GSharp doesn't intend to take developers away from Go, although Go skills should be transferable to GSharp development: grammar, channels, goroutines, etc.

## Contributing
Contributions to this project are welcome. Before you submit a pull request, open an issue to discuss your idea, the problem it solves, the desired implementation and after that a PR can be considered. This should expedite the PR acceptance process.

## Name
The GSharp language takes its name from [CSharp](https://github.com/dotnet/csharplang) and [Go](https://go.googlesource.com/go), reflecting its roots and target (.NET). If there are any trademark issues with calling it that way I'm happy to also call it [AFlat](https://www.uberchord.com/blog/g-sharp-or-a-flat-on-guitar-chord-shapes-major-scale-songs-in-the-key-of-g-sharp-a-flat/).

I also wouldn't mind calling it `Festivus` (a programming language for the restofus).

#### Other interesting links
  - [An Exhausting List of Differences Between VB.NET & C#](https://anthonydgreen.net/2019/02/12/exhausting-list-of-differences-between-vb-net-c/)
  - [“Go programmer claims he doesn’t need generics”](https://classicprogrammerpaintings.com/post/144854447139/go-programmer-claims-he-doesnt-need-generics)
  - [The value in Go's simplicity](https://benjamincongdon.me/blog/2019/11/11/The-Value-in-Gos-Simplicity/)
  - [Learn Go in ~5mins](https://gist.github.com/prologic/5f6afe9c1b98016ca278f4d507e65510)

ab0678fa-3a72-487d-8eae-7cdec82efedf
