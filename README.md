# G#
G# Programming Language.
A modern, simple, and accessible programming language for .NET.

[![build](https://github.com/DavidObando/gsharp/actions/workflows/build.yml/badge.svg)](https://github.com/DavidObando/gsharp/actions/workflows/build.yml)

📖 **Documentation:** https://davidobando.github.io/gsharp/ — language tour, tutorials, specification, and tooling reference. The site source lives in [`website/`](website/).

![](assets/gsharp-icon.svg?raw=true)

## Getting started

G# ships an MSBuild SDK ([`Gsharp.NET.Sdk`](https://www.nuget.org/packages/Gsharp.NET.Sdk/)) and a `dotnet new` template package ([`Gsharp.Templates`](https://www.nuget.org/packages/Gsharp.Templates/)), both available on NuGet, so a `.gsproj` is just a regular .NET project that happens to compile `.gs` files. After installing the template package, you can scaffold and run a console app in three commands:

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

The SDK is validated against `net8.0` and `net10.0`; adding additional target frameworks is a one-line change in [`e2etests/multitarget-e2e.sh`](e2etests/multitarget-e2e.sh). See [`docs/sdk-usage.md`](docs/sdk-usage.md) for the full SDK + templates walkthrough and [`docs/emit-pipeline.md`](docs/emit-pipeline.md) for the compiler architecture.

## Editor support

The **G# VS Code extension** is published on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp). It provides syntax highlighting, language-server features (completion, hover, diagnostics, formatting, and more), build/run commands, and debugger configuration for `.gs` and `.gsproj` files. Install it from within VS Code (search for "G#") or from the command line:

```sh
code --install-extension gsharplang.vscode-gsharp
```

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
  Core/               # Shared front-end: syntax, binder, lowering, symbols, emit
  Compiler/           # gsc.dll command-line driver
  Interpreter/        # In-process evaluator (REPL + language tests)
  LanguageServer/     # LSP server backing the editor experience
  Sdk/
    Gsharp.NET.Sdk/   # MSBuild SDK that wires .gsproj into dotnet build
    Gsharp.Templates/ # dotnet new template package (gsharp-console)
samples/              # HelloWorld and other end-user fixtures
e2etests/             # End-to-end smoke scripts: sdk-e2e, templates-e2e, multitarget-e2e
test/                 # xUnit projects covering Core, Compiler, Interpreter, LSP
```

## Samples
Here's a few introductory samples of G#.

A unit test:
```swift
package GsharpLibrary.Tests

import Xunit
import GsharpLibrary

type GreeterTests class {
    @Fact
    func Greet_Returns_Hello_With_Name() {
        var greeter = Greeter()

        Assert.Equal("Hello, World!", greeter.Greet("World"))
    }

    @Theory
    @InlineData("Alice", "Hello, Alice!")
    @InlineData("Bob", "Hello, Bob!")
    func Greet_Formats_Each_Name(name string, expected string) {
        var greeter = Greeter()

        Assert.Equal(expected, greeter.Greet(name))
    }
}
```

Scoped goroutines:
```swift
package GSharp.Samples.GoScope

import System

func send(value int32, ch chan int32) int32 {
    ch <- value
    return 0
}

let ch = make(chan int32, 3)
scope {
    go send(1, ch)
    go send(2, ch)
    go send(3, ch)
}

let a = <-ch
let b = <-ch
let c = <-ch
Console.WriteLine(a + b + c)
```

Patterns:
```swift
package GSharp.Samples.Patterns

import System

let number = 7
let numericLabel = switch number {
  case < 0 -> "negative"
  case > 0 -> "positive"
  default -> "zero"
}

let values = []int32{1, 2, 3}
let listLabel = switch values {
  case [1, _, 3] -> "bookended"
  case _ -> "other"
}

Console.WriteLine("$numericLabel / $listLabel")
```

Generic methods:
```swift
package GSharp.Example.GenericMethods

import System

// Instance generic methods on a non-generic class. `Wrap` uses `T` in its
// parameter, return type, and a local; `Pair` declares two type parameters.
type Box class {
    func Wrap[T](item T) T {
        var local T = item
        return local
    }

    func Pair[T, U](a T, b U) T {
        return a
    }
}

// A generic method declared on a generic class: `Echo` uses the class's `T`
// while `GetOr` introduces its own method-level type parameter `U`.
type Container[T] class {
    var Value T

    func Echo(x T) T {
        return x
    }

    func GetOr[U](other U) U {
        return other
    }
}

// A generic static method declared inside a `shared` block.
type Util class {
    shared {
        func Identity[T](x T) T {
            return x
        }
    }
}

var b = Box{}
Console.WriteLine(b.Wrap(42))
Console.WriteLine(b.Wrap("text"))
Console.WriteLine(b.Pair(7, "ignored"))
Console.WriteLine(b.Wrap[int32](100))

var c = Container[int32]{Value: 10}
Console.WriteLine(c.Echo(5))
Console.WriteLine(c.GetOr("hello"))

Console.WriteLine(Util.Identity(99))
Console.WriteLine(Util.Identity("z"))
```

## Contributing
Contributions to this project are welcome. Before you submit a pull request, open an issue to discuss your idea, the problem it solves, the desired implementation and after that a PR can be considered. This should expedite the PR acceptance process.
