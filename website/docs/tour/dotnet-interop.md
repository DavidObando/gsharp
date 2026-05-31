---
title: "Tour: .NET interop"
sidebar_position: 6
draft: false
---

# Tour: .NET interop

G# targets the CLR, so importing and using .NET APIs is part of the language's core workflow. Imports can bring CLR namespaces into scope, aliases can shorten names, and emitted assemblies use normal .NET metadata.

## Imports and aliases

The compiler implicitly imports `System` by default, so `Console` is available in simple programs. You can disable that with `/noimplicitimports` and write imports explicitly.

```gsharp title="ImplicitImport.gs"
package ImplicitImport

Console.WriteLine("Hello without import!")
```

```text
Hello without import!
```

Aliases use `import name = Namespace`:

```gsharp title="ImportAlias.gs"
package ImportAlias

import sys = System

sys.Console.WriteLine("Hello from alias!")
```

```text
Hello from alias!
```

## CLR collections and generic types

Imported CLR types use G# generic brackets. Constructors, instance methods, properties, indexers, and `for in` over enumerable values are available through binding.

```gsharp
package Tour.Interop

import System
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)

for value in list {
    Console.WriteLine(value)
}
```

## Extension functions

G# extension functions use a Go-style receiver clause. They are called with instance syntax.

```gsharp title="ExtensionFunctions.gs"
package GSharp.Example.ExtensionFunctions

import System

func (value int32) Abs() int32 {
    if value < 0 {
        return -value
    }

    return value
}

func (value int32) Scale(factor int32) int32 {
    return value * factor
}

var n = -7
var one = 1
Console.WriteLine(n.Abs())
Console.WriteLine(one.Scale(10))
```

```text
7
10
```

G# can also call imported CLR extension methods with receiver syntax. LINQ methods are a good example:

```gsharp title="LinqExtensions.gs"
package GSharp.Example.LinqExtensions

import System
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)
list.Add(5)
list.Add(6)

var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
for v in evens {
    Console.WriteLine(v)
}

Console.WriteLine(list.Sum())
```

```text
2
4
6
21
```

## Events and delegates

Event subscription uses `+=` and `-=`. Function literals can materialize as compatible CLR delegate types on the emit path.

```gsharp title="EventSubscription.gs"
package GSharp.Example.EventSubscription

import System

var domain = AppDomain.CurrentDomain

domain.ProcessExit += func(sender Object, e EventArgs) {
    Console.WriteLine("would only fire if not removed")
}

Console.WriteLine("subscribed")
```

```text
subscribed
would only fire if not removed
```

Use emitted builds for delegate-heavy interop. The interpreter can evaluate many imported members by reflection, but it cannot marshal every G# function literal into a CLR delegate the same way an emitted assembly can.

Next: [Tutorials](/docs/tutorials/getting-started), or go deeper with the [CLR interop reference](/docs/ref/clr-interop).
