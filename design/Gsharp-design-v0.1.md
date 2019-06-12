# Ideas for GSharp version 0.1
The goal of GSharp 0.1 is to be able to produce a "hello world" style console application, ideally targeting .NET Core 3.0. As a stretch goal, it will also support declaration, assignment and evaluation of `int` and `bool` variables, as well as `if` (conditional) and `for` (loop) statements.

The language grammar will be initially derived from Go's grammar, plus additions where it makes sense in order to support using .NET Core libraries. Note that GSharp may not necessarily support generics anytime soon.

## Prototype program: Hello World
Here's an example "hello world" written in GSharp:
```go
// file: HelloWorld.gs

package HelloWorld

import System

func Main() {
  Console.WriteLine("Hello, world!")
}
```

Compare to the C# equivalent:
```csharp
// file: HelloWorld.cs

using System;

class HelloWorld
{
    static void Main(string[] args)
    {
        Console.WriteLine("Hello, World!");
    }
}
```
## Prototype program: if and loop
This program receives tries to parse the first command line argument as an integer, and then does that many loops printing values all the way to 1.
```go
// file: Loop.gs

package GSharp.Example.Loop

import System

func Main(args: string[]) {
  count := 0
  if args.Length == 1 {
    Int.TryParse(args[0], *count)
  }
  
  for i := count; i > 0; i-- {
    Console.WriteLine("Count value: {i}")
  }
}
```
Compare to the C# equivalent:
```csharp
// file: Loop.cs

namespace GSharp.Example
{
    using System;

    class Loop
    {
        static void Main(string[] args)
        {
            var count = 0;
            if (args.Length == 1)
            {
                Int.TryParse(args[0], out count);
            }
            
            for (var i = count; i > 0; i--)
            {
                Console.WriteLine($"Count value: {i}");
            }
        }
    }
}
```

## Notes
I found an interesting project that attempts to convert Go code to C# code. It has interesting ideas in it:
  - https://github.com/GridProtectionAlliance/go2cs

Here's an ANTLR 4 grammar for Go, usable to understand what are expressions that we could/should support:
  - https://github.com/antlr/grammars-v4/blob/master/golang/Golang.g4
