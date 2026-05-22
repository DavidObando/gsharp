# Ideas for GSharp version 0.1
The goal of GSharp 0.1 is to be able to produce a "hello world" style console application, ideally targeting .NET 10. As a stretch goal, it will also support declaration, assignment and evaluation of `int` and `bool` variables, as well as `if` (conditional) and `for` (loop) statements.

The language grammar will be initially derived from Go's grammar, plus additions where it makes sense in order to support using .NET Core libraries. Note that GSharp may not necessarily support generics anytime soon.

## Prototype program: Hello World
GSharp supports **top-level statements** (C# 9-style). A `.gs` file may consist of statements directly at the top of the file; the compiler synthesizes an entry point that executes them in order. An explicit `func Main()` is allowed but not required.

Here's an example "hello world" written in GSharp:
```go
// file: HelloWorld.gs

package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

Compare to the C# equivalent (also using top-level statements):
```csharp
// file: HelloWorld.cs

using System;

Console.WriteLine("Hello, World!");
```

## Prototype program: if and loop
This program tries to parse the first command line argument as an integer, and then does that many loops printing values all the way to 1. With top-level statements, command-line arguments are available via the implicit `args` parameter on the synthesized entry point:
```go
// file: Loop.gs

package GSharp.Example.Loop

import System

count := 0
if args.Length == 1 {
  Int.TryParse(args[0], *count)
}

for i := count; i > 0; i-- {
  Console.WriteLine("Count value: {i}")
}
```
Compare to the C# equivalent (top-level statements form):
```csharp
// file: Loop.cs

using System;

var count = 0;
if (args.Length == 1)
{
    Int.TryParse(args[0], out count);
}

for (var i = count; i > 0; i--)
{
    Console.WriteLine($"Count value: {i}");
}
```

### Entry-point synthesis rules
- A compilation that contains any top-level statements must contain exactly one source file with top-level statements; multiple files with top-level statements is a compile error.
- The binder synthesizes a single hidden method (conceptually `<TopLevel>$.<Main>$(string[] args)`) whose body is the lowered top-level `BoundBlockStatement`. The emitter marks that method as the assembly entry point.
- An explicit `func Main()` (or `func Main(args string[])`) is supported and takes precedence: when present, top-level statements are not allowed in the same compilation.

## Notes
I found an interesting project that attempts to convert Go code to C# code. It has interesting ideas in it:
  - https://github.com/GridProtectionAlliance/go2cs

Here's an ANTLR 4 grammar for Go, usable to understand what are expressions that we could/should support:
  - https://github.com/antlr/grammars-v4/blob/master/golang/Golang.g4
