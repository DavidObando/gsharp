---
title: "Tour: Basics"
sidebar_position: 2
draft: false
---

# Tour: Basics

G# programs are organized into packages, can import CLR namespaces, and can use top-level statements for small executables.

```gsharp title="HelloWorld.gs"
// file: HelloWorld.gs

package HelloWorld

import System

Console.WriteLine("Hello, world!")
```

```text
Hello, world!
```

`Console` comes from the .NET `System` namespace. The compiler also has an implicit `System` import by default; `/noimplicitimports` disables it.

## Variables and constants

G# has `var`, `let`, and `const` declarations. `var` is mutable and may be declared with an explicit type and no initializer, which gives it the type's zero value. `let` is for values that are initialized once, including deconstruction forms. `const` is for compile-time constants.

```gsharp
package Tour.Basics

import System

var total = 0
let name = "G#"
const answer = 42

Console.WriteLine(name)
Console.WriteLine(answer)
```

Zero values are useful when a variable will be assigned later:

```gsharp title="ZeroValues.gs"
package GSharp.Example.ZeroValues

import System

var x int32
var flag bool
var text string

Console.WriteLine("x=${x} flag=${flag} text=[${text}]")

x = 42
flag = true
text = "set"

Console.WriteLine("x=${x} flag=${flag} text=[${text}]")
```

```text
x=0 flag=False text=[]
x=42 flag=True text=[set]
```

## Functions

Functions begin with `func`. Parameters are named, their types follow the names, and an optional return type follows the parameter list.

```gsharp title="Arithmetic.gs"
package GSharp.Example.Arithmetic

import System

func add(num1 int32, num2 int32) int32 {
    return num1 + num2
}

var sum = 0
for i in 1 ... 5 {
    sum = sum + i
}

Console.WriteLine(add(2, 3))
Console.WriteLine(sum)
```

```text
5
10
```

### Variadic parameters

A parameter declared with an ellipsis between its name and its element type — `name ...T` — accepts any number of trailing arguments. Inside the body the parameter is a slice (`[]T`); the call site can pass either positional arguments (which are packed into a fresh slice) or a single `[]T` value (which is forwarded unwrapped). At most one variadic parameter is allowed per signature and it must be the last parameter.

```gsharp title="Variadic.gs"
package GSharp.Example.Variadic

import System

func sum(nums ...int32) int32 {
    var total = 0
    for v in nums {
        total = total + v
    }
    return total
}

Console.WriteLine(sum(1, 2, 3, 4, 5))
Console.WriteLine(sum())

let arr = []int32{10, 20, 30}
Console.WriteLine(sum(arr))
```

```text
15
0
60
```

The emitted method carries `[System.ParamArrayAttribute]` so it is consumable from C# / F# / VB as if it had been declared with `params T[]`. The variadic spelling is accepted on top-level `func`, class methods, interface methods (including default-body methods), constructors, lambdas, and named delegate declarations.

## Basic types

The primitive names are explicit about width: `bool`, `int32`, `uint32`, `int64`, `uint64`, `float32`, `float64`, `decimal`, `char`, `string`, and `object` are common examples. Older aliases such as `int`, `uint`, `long`, and `byte` are not G# built-in primitive names.

Strings support sigil-free interpolation with `$name` and braced `${expr}` holes inside ordinary string literals. Holes may add an alignment and format clause, `${expr,alignment:format}`:

```gsharp title="InterpolatedString.gs"
package InterpolatedString

let name = "world"
let n = 6
Console.WriteLine("Hello, $name!")
Console.WriteLine("answer = ${n * 7}")
Console.WriteLine("$$ stays literal")
```

```text
Hello, world!
answer = 42
$ stays literal
```

Next: [Tour: Types and values](/docs/tour/types).
