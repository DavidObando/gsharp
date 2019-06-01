# Ideas for GSharp version 0.1
The goal of GSharp 0.1 is to be able to produce a hello-world style console application, ideally targeting .NET Core 3.0. As a stretch goal, it will also support `if` (conditional) and `for` (infinite loop) statements.

The language grammar will be initially derived from Go's grammar, plus additions where it makes sense in order to support using .NET Core libraries.

## Prototype program
Here's an example "hello world" written in GSharp:
```gsharp
// file: hello-world.gs
module HelloWorld

import System

func main() {
  Console.WriteLine("Hello, world!")
}
```

Compare to the C# equivalent:
```csharp
// file: HelloWorld.cs

using System;

public class HelloWorld
{
    public static void main(string[] args)
    {
        Console.WriteLine("Hello, World!");
    }
}
```
