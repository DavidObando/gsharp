---
title: "Tour: Control flow"
sidebar_position: 4
draft: false
---

# Tour: Control flow

G# uses `if`, `switch`, and `for` for ordinary control flow. There is no `while` keyword; use `for condition` for while-style loops.

## If

`if` conditions are expressions and blocks use braces.

```gsharp
package Tour.ControlFlow

import System

let n = 7
if n > 0 {
    Console.WriteLine("positive")
} else {
    Console.WriteLine("zero or negative")
}
```

## For

G# supports C-style `for init; condition; post`, condition-only `for`, infinite `for`, and range forms. The ellipsis form is convenient for integer ranges.

```gsharp title="Loop.gs"
package GSharp.Example.Loop

import System

var count = 5

for i := count; i > 0; i-- {
    Console.WriteLine("Count value: $i")
}
```

```text
Count value: 5
Count value: 4
Count value: 3
Count value: 2
Count value: 1
```

## For-in and range

`for v in collection` is the preferred collection iteration form. A two-variable form can iterate key-value pairs from CLR dictionaries.

```gsharp title="ForIn.gs"
import System
import System.Collections.Generic

var nums = []int32{1, 2, 3}
for v in nums {
    Console.WriteLine(v)
}

var dict = Dictionary[string, int32]()
dict["one"] = 1
dict["two"] = 2
for k, v in dict {
    Console.WriteLine(k)
    Console.WriteLine(v)
}
```

```text
1
2
3
one
1
two
2
```

The older `for x := range values` spelling is still accepted and appears in some samples.

## Switch statements

Switch cases have block bodies and do not fall through. The `fallthrough` token is reserved, but using it is diagnosed rather than executed.

```gsharp title="PatternSwitch.gs"
package GSharp.Samples.PatternSwitch

import System

func describe(n int32) {
  switch n {
    case 0 { Console.WriteLine("zero") }
    case < 0 { Console.WriteLine("negative") }
    case > 100 { Console.WriteLine("huge") }
    default { Console.WriteLine("positive small") }
  }
}

describe(-5)
describe(0)
describe(7)
describe(250)
```

```text
negative
zero
positive small
huge
```

## Switch expressions and patterns

Switch expressions use `->` arms and produce a value. Patterns include constants, relational forms, discard, type patterns, property patterns, and list patterns.

```gsharp title="SwitchExpression.gs"
package GSharp.Samples.SwitchExpression

import System

let nums = []int32{-3, 0, 1, 5, 101}
for n in nums {
  let label = switch n {
    case 0 -> "zero"
    case < 0 -> "neg"
    case > 100 -> "huge"
    default -> "small-pos"
  }
  Console.WriteLine("$n -> $label")
}
```

```text
-3 -> neg
0 -> zero
1 -> small-pos
5 -> small-pos
101 -> huge
```

Next: [Tour: Concurrency](/docs/tour/concurrency).
