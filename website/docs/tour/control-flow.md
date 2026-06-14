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

## `if` as a value

`if` can also sit in expression position. The form requires a terminal `else`, supports `else if` chains, and may use multi-statement blocks whose trailing expression is the branch value.

```gsharp
let label = if n > 0 { "positive" } else if n < 0 { "negative" } else { "zero" }

let title = if user.IsAdmin {
    log("admin route")
    "Admin Dashboard"
} else {
    "Home"
}
```

The result type is the common type of all branch tails (same rule as the ternary `?:` operator). Missing the terminal `else` in value position reports `GS0276`; an empty block reports `GS0277`; branches with no common type report `GS0263`. The statement form is unchanged — `if cond { … }` (no else) still parses and behaves exactly as before.

## `if let` and `guard let` — nullable bindings

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
the binding compose with the rest of the smart-cast machinery.

## `??=` — null-coalescing compound assignment

`a ??= b` is the compound shorthand for *"if `a` is currently `nil`,
evaluate `b` and write the result into `a`."* The right-hand side is
**short-circuited** when the lvalue is already non-nil — it is evaluated
only in the nil-case — and the receiver/index expressions on the left are
evaluated exactly once across the read-test-write triple.

```gsharp
var greeting string? = nil
greeting ??= "hello"   // greeting is now "hello"
greeting ??= "ignored" // no-op — RHS not evaluated
```

The left-hand side may be any writable nullable lvalue: a local, a field on
a struct or class, an auto-property or computed property with a setter, or
an indexer access (G#-native or CLR). Non-nullable targets are rejected with
`GS0298`; non-assignable targets with `GS0299`. The operator works
identically for nullable reference types (`string?`, `Person?`) and
nullable value types (`int32?`, `bool?`).


## For

G# supports C-style `for init; condition; post`, condition-only `for`, infinite `for`, and range forms. The ellipsis form is convenient for integer ranges.

```gsharp title="Loop.gs"
package GSharp.Example.Loop

import System

var count = 5

for var i = count; i > 0; i-- {
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

## While and do-while

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

## Labeled break and continue

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
    case 0: "zero"
    case < 0: "neg"
    case > 100: "huge"
    default: "small-pos"
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

## Smart casts (flow narrowing)

After a successful `is` (or `!is`) test against a local, parameter, or read-only top-level `let`, G# automatically narrows the receiver to the tested type for the rest of the flow region. No explicit `as`-cast is required.

```gsharp
open class Animal {
    var Name string
}

class Dog : Animal {
    func Bark() string { return Name + ": woof" }
}

func Speak(a Animal) {
    if a is Dog {
        Console.WriteLine(a.Bark())   // a is Dog inside the then-block
    }
}

func SpeakOrSilent(a Animal) {
    if a !is Dog { return }
    Console.WriteLine(a.Bark())       // a is Dog in the rest of the function
}
```

Narrowing composes with `&&` and `||`. `&&` threads the left operand's narrowing into the right operand; `||` is the De Morgan dual — its right operand sees the inverted narrowing from the left, and the combined else-frame is the merge of both operands' negative narrowings, which the early-exit lift can surface into the rest of the block.

```gsharp
// && narrows the right operand.
if a is Dog && a.Name != "" {
    Console.WriteLine(a.Bark())
}

// || + early-exit guard: a is Dog AND silent is false in the rest of the function.
func GreetOrSilent(a Animal, silent bool) {
    if !(a is Dog) || silent {
        return
    }
    Console.WriteLine(a.Bark())
}
```

`switch` arms narrow the discriminator in addition to the bound arm variable. When the switch is exhaustive (has a `default` arm) AND every non-exiting arm contributes the same narrowing, that narrowing is lifted into the rest of the enclosing block after the switch.

```gsharp
func Describe(a Animal) string {
    switch a {
        case d is Dog { return a.Bark() }   // a is Dog inside this arm
        case c is Cat { return a.Purr() }   // a is Cat inside this arm
        default       { return a.Name }
    }
}
```

Reassignment to a narrowed receiver inside the narrowed region drops the narrowing for the remainder of the region. Fields, properties, and indexed expressions are never narrowed because their reads are not idempotent.

Next: [Tour: Concurrency](/docs/tour/concurrency).
