# G# Language Skill

## Overview

G# (GSharp) is a new .NET language that combines Go-inspired syntax with modern .NET capabilities. It compiles to .NET IL and runs on any .NET runtime (Core, Framework, NativeAOT). The language targets .NET 10+ and provides a production-ready compiler, language server, REPL, VS Code extension, and MSBuild SDK.

This skill provides guidance for working with G# code, understanding its syntax and semantics, building G# projects, and using the G# tooling.

## When to Use This Skill

- Writing or reviewing G# (.gs) source files
- Creating new G# projects using `dotnet new gsharp-*` templates
- Debugging G# compiler diagnostics (GS#### codes)
- Understanding G# language features: nullability, generics, concurrency, pattern matching
- Working with the G# SDK (MSBuild integration, project files)
- Using the G# REPL or VS Code extension
- Interoperating with C#/.NET libraries from G#

## Key Language Features

### Syntax Basics
- **File extension**: `.gs`
- **Package declaration**: `package MyPackage` (required at top of file)
- **Imports**: `import System` / `import System.Collections.Generic`
- **Top-level statements**: Supported (synthesizes `Main` entry point)
- **Explicit entry point**: `func Main()` or `func Main(args []string)`

### Type System
- **Predeclared types**: `bool`, `int8`/`uint8`, `int16`/`uint16`, `int32`/`uint32`, `int64`/`uint64`, `nint`/`nuint`, `float32`/`float64`, `decimal`, `char`, `string`, `object`
- **Nullability**: Kotlin-style — reference types non-null by default, `T?` for nullable, `nil` literal
- **Smart casts**: After `!= nil` check, type narrows to non-null
- **Safe call**: `x?.member`, **Null coalescing**: `x ?? default`, **Null assert**: `x!!`

### Variable Bindings
- `var x = 1` — mutable
- `let x = 1` — immutable (runtime)
- `const Pi = 3.14` — compile-time constant
- `x := 1` — short mutable declaration (type inferred)

### Generics
- **Square brackets**: `List[int]`, `func Map[T, U](xs []T, f func(T) U) []U`
- **Constraints**: `any`, `struct`, `class`, interface names
- **Reified generics**: CLR-style, fully supported at runtime

### Data Types
- `struct Point(x, y int)` — value type
- `data struct Point(x, y int)` — synthesizes `Equals`, `GetHashCode`, `Copy`, destructuring
- `interface Shape { Area() float64 }`
- `sealed interface Shape { }` — enables exhaustive `switch`
- `class Circle : Shape { ... }` — single inheritance, `override` allowed

### Functions & Methods
- `func Add(a, b int) int { return a + b }`
- **Extension functions**: `func (s string) Shout() string { return s.ToUpper() + "!" }`
- **Receiver methods**: `func (p Point) Distance() float64 { ... }`
- **Generics**: `func Identity[T any](x T) T { return x }`
- **Variadic**: `func Sum(nums ...int) int { ... }`

### Control Flow
- `if x > 0 { ... } else { ... }` — also expression
- `for i := 0; i < n; i++ { ... }` — C-style
- `for x := range xs { ... }` — range over slice/array/map/channel
- `while cond { ... }` — while loop
- `switch x { case 0 -> "zero"; case > 100 -> "big"; default -> "other" }` — expression or statement, exhaustive over sealed types
- `defer Cleanup()` — runs at function exit (LIFO)
- `go Worker()` — spawns goroutine (structured within `scope { }`)

### Concurrency
- `chan int` — channel type
- `ch <- value` — send
- `<-ch` — receive
- `select { case <-ch1: ...; case ch2 <- v: ...; default: ... }`
- `async func Fetch() string { ... }` — .NET async/await
- `scope { go worker(ch); result := <-ch }` — structured concurrency

### Pattern Matching (in `switch`)
- Constant: `case 42 -> ...`
- Relational: `case > 0 -> ...`, `case <= 100 -> ...`
- Type: `case string s -> ...`, `case Point(x, y) -> ...`
- Variable: `case let x -> ...`
- Wildcard: `default -> ...` or `case _ -> ...`

### Error Handling
- `try { ... } catch (e ExceptionType) { ... } finally { ... }`
- No checked exceptions, no multi-return error idiom

### Visibility
- `public` (default), `internal`, `private` — explicit modifiers
- No capitalization-based visibility

### Interop
- Import CLR namespaces: `import System.Collections.Generic`
- Use CLR types directly: `List[int]`, `Dictionary[string, int]`
- Extension functions on CLR types
- P/Invoke: `@DllImport("kernel32") func GetTickCount() uint32`

## Project Structure

```
MyProject/
├── MyProject.gsproj          # MSBuild project (SDK: Gsharp.NET.Sdk)
├── Program.gs                # Entry point
├── Models.gs                 # Types
├── Services.gs               # Logic
└── obj/ bin/                 # Build output
```

### Project File (`.gsproj`)
```xml
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="SomeNuGetPackage" Version="1.0.0" />
  </ItemGroup>
</Project>
```

## Building & Running

```bash
# Create new project
dotnet new gsharp-console -n MyApp
cd MyApp
dotnet build
dotnet run

# Other templates: gsharp-lib, gsharp-web, gsharp-xunit
dotnet new gsharp-lib -n MyLib
dotnet new gsharp-web -n MyApi
dotnet new gsharp-xunit -n MyTests
```

## Diagnostics (GS####)

All diagnostics have stable `GS####` codes. Common categories:
- **GS0001–GS0005**: Lexer errors
- **GS0100–GS0189**: Binder/semantic errors
- **GS0200+**: Other diagnostics

Suppress in `.gsproj`:
```xml
<PropertyGroup>
  <NoWarn>GS0168</NoWarn>
  <WarningsAsErrors>GS0176</WarningsAsErrors>
</PropertyGroup>
```

## Tooling

| Tool | Command | Purpose |
|------|---------|---------|
| Compiler | `dotnet build` | Via MSBuild SDK |
| REPL | `dotnet run --project src/Repl` | Interactive shell |
| Language Server | VS Code extension | IDE support |
| Formatter | Built into LSP | `dotnet format` not yet supported |

## References

The `references/` directory contains:
- `lexical.md` — Lexical specification (keywords, literals, strings, interpolation)
- `design-v0.2.md` — Locked language design decisions (D1–D11)
- `diagnostics.md` — Diagnostic codes and suppression
- `emit-pipeline.md` — Compiler emit architecture
- `coverage-matrix.md` — Language construct coverage
- `adr/` — Architecture Decision Records for each design decision

## Best Practices

1. **Prefer `let` over `var`** for immutable bindings
2. **Use `data struct`** for DTOs/value objects — free `Equals`/`GetHashCode`
3. **Use extension functions** instead of adding methods to types you don't own
4. **Enable exhaustive `switch`** with `sealed interface` for domain modeling
5. **Use `scope { }`** for structured concurrency — prevents leaked goroutines
6. **Import CLR namespaces** directly — no wrapper types needed
7. **Central Package Management** — use `Directory.Packages.props` in solutions

## Common Tasks

### Creating a new G# console app
```bash
dotnet new gsharp-console -n MyApp
cd MyApp
dotnet run
```

### Adding a NuGet package
```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

### Writing a test (xUnit template)
```bash
dotnet new gsharp-xunit -n MyTests
```
```gs
// GreeterTests.gs
package MyTests

import Xunit

func TestGreeter() {
    let g = Greeter("World")
    Assert.Equal("Hello, World!", g.Greet())
}
```

### Using Go-style concurrency
```gs
import System.Threading.Channels

func Worker(id int, jobs <-chan int, results chan<- int) {
    for j := range jobs {
        results <- j * 2
    }
}

scope {
    jobs := make(chan int, 100)
    results := make(chan int, 100)
    
    for i := 1; i <= 3; i++ {
        go Worker(i, jobs, results)
    }
    
    for j := 1; j <= 9; j++ {
        jobs <- j
    }
    close(jobs)
    
    for i := 1; i <= 9; i++ {
        Console.WriteLine(<-results)
    }
}
```

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| `GS0001` bad character | Check for non-UTF8 or invalid Unicode |
| `GS0100` type not found | Add `import` or check package reference |
| `GS0123` nullable mismatch | Add `?` or handle `nil` case |
| Build fails: SDK not found | Ensure `Gsharp.NET.Sdk` is installed via `dotnet new` |
| LSP not starting | Install VS Code extension from `src/vscode-gsharp` |

## Version Info

- Language version: 0.2 (design locked)
- Target framework: .NET 10+
- SDK: `Gsharp.NET.Sdk` (MSBuild)
- Parser: Hand-written recursive descent
- Binder: Flow-sensitive, nullability-aware
- Backends: Interpreter (authoritative) + ReflectionMetadataEmitter (AOT-ready)

---

*This skill is maintained alongside the G# compiler in the `SKILLS/gsharp-language` directory.*