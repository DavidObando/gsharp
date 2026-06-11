---
title: "Tour: Control flow"
sidebar_position: 4
draft: false
---

# Tour: Control flow

G# uses `if`, `switch`, `for`, `while`, and `do`-`while` for ordinary control flow.

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

## `if let` and `guard let` — nullable bindings (ADR-0071)

`if let name = expr { ... }` strips the nullable layer from a value and binds
the underlying non-null view to `name` inside the then-branch. The companion
`guard let name = expr else { exit }` form binds `name` for the **remainder
of the enclosing block**; the else clause must unconditionally exit.

```gsharp
func Greet(name string?) {
    if let n = name {
        Console.WriteLine("hi $n")
    } else {
        Console.WriteLine("hi stranger")
    }
}

func Length(s string?) int32 {
    guard let v = s else {
        return -1
    }

    // `v` is `string` (not `string?`) here, for the rest of the block.
    return v.Length
}
```

Multiple comma-separated bindings are supported and narrow all-or-nothing:

```gsharp
if let a = left, let b = right {
    Console.WriteLine("$a + $b")
}
```

The binding's initializer must have a nullable type (`T?`). The else-block of
`guard let` must end in `return`, `throw`, `break`, or `continue` (or be a
nested block whose last statement does the same). Inside the body, reads of
the binding compose with the rest of the smart-cast machinery from
[ADR-0069](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0069-smart-cast-flow-narrowing.md).

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

## While and do-while (ADR-0070)

`while cond { ... }` evaluates `cond` first and runs the body while it is true.
`do { ... } while cond` is the post-test variant: the body always runs at least
once. Both forms support `break` and `continue` exactly like `for`.

```gsharp title="WhileDo.gs"
import System

var i = 0
while i < 3 {
    Console.WriteLine(i)
    i = i + 1
}

var j = 5
do {
    Console.WriteLine(j)
    j = j + 1
} while j < 5
```

```text
0
1
2
5
```

## Labeled break and continue (ADR-0070)

Loops can be prefixed with a `label:` declaration. `break label` and
`continue label` then jump out of (or to the next iteration of) the named
enclosing loop instead of the innermost one. Labels work uniformly on `for`,
`while`, and `do`-`while`.

```gsharp title="LabeledBreak.gs"
import System

outer: for i in 1...3 {
    for j in 1...3 {
        if i == 2 && j == 2 {
            break outer
        }
        Console.WriteLine(i)
        Console.WriteLine(j)
    }
}
```

```text
1
1
1
2
1
3
2
1
```

Misplaced labels (`label:` on something that is not a loop) and unknown labels
on `break`/`continue` are diagnosed with **GS0294** and **GS0293** respectively.
Shadowing an enclosing loop's label produces the warning **GS0295**.

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
