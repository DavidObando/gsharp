---
title: "Tour: Control flow"
sidebar_position: 4
draft: false
---

# Tour: Control flow

G# uses `if`, `switch`, `for`, `while`, and `do`-`while` for ordinary control flow.

## If

`if` conditions are expressions and blocks use braces.

```gsharp title="If.gs"
package Tour.ControlFlow.If

import System

func Main() {
    let n = 7
    if n > 0 {
        Console.WriteLine("positive")
    } else {
        Console.WriteLine("zero or negative")
    }
}
```

## `if` as a value

`if` can also sit in expression position. The form requires a terminal `else`, supports `else if` chains, and may use multi-statement blocks whose trailing expression is the branch value.

```gsharp title="IfExpression.gs"
package Tour.ControlFlow.IfExpression

import System

func log(message string) {
    Console.WriteLine(message)
}

func Main() {
    let n = 7
    let label = if n > 0 { "positive" } else if n < 0 { "negative" } else { "zero" }

    let title = if label == "positive" {
        log("admin route")
        "Admin Dashboard"
    } else {
        "Home"
    }

    Console.WriteLine(title)
}
```

The result type is the common type of all branch tails. Missing the terminal `else` in value position reports `GS0276`; an empty block reports `GS0277`; branches with no common type report `GS0263`.

## `if let` and `guard let` — nullable bindings

`if let name = expr { ... }` strips the nullable layer from a value and binds the underlying non-null view to `name` inside the then-branch. The companion `guard let name = expr else { exit }` form binds `name` for the remainder of the enclosing block; the else clause must unconditionally exit.

```gsharp title="NullableBindings.gs"
package Tour.ControlFlow.NullableBindings

import System

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

    return v.Length
}

func Both(left string?, right string?) {
    if let a = left, let b = right {
        Console.WriteLine("$a + $b")
    }
}
```

The binding's initializer must have a nullable type (`T?`). The else-block of `guard let` must end in `return`, `throw`, `break`, or `continue`.

## `??=` — null-coalescing compound assignment

`a ??= b` is the compound shorthand for *"if `a` is currently `nil`, evaluate `b` and write the result into `a`."* The right-hand side is evaluated only in the nil case.

```gsharp title="NullCoalescingAssign.gs"
package Tour.ControlFlow.NullCoalescingAssign

func Fill() string {
    var greeting string? = nil
    greeting ??= "hello"
    greeting ??= "ignored"
    return greeting ?? "fallback"
}
```

Use `??` for the read operator and `??=` for assignment.

## Throw expressions

`throw` can appear in value position. It is useful with `??` when a nullable value is required to be present.

```gsharp title="ThrowExpression.gs"
package Tour.ControlFlow.ThrowExpression

import System

func RequireName(name string?) string {
    return name ?? throw Exception("name is required")
}
```

## For

G# supports C-style `for init; condition; post`, condition-only `for`, infinite `for`, and range forms. The ellipsis form is convenient for integer ranges. `++` and `--` work as statements and as value-producing prefix/postfix expressions.

```gsharp title="Loop.gs"
package GSharp.Example.Loop

import System

func Main() {
    var count = 5

    for var i = count; i > 0; i-- {
        Console.WriteLine("Count value: $i")
    }

    var n = 1
    let old = n++
    let current = ++n
    Console.WriteLine(old)
    Console.WriteLine(current)
}
```

## For-in, from-end indexing, and ranges

`for v in collection` is the preferred collection iteration form. From-end indexes use `^n`, ranges use `lo..hi`, and a standalone range value can be reused for indexing.

```gsharp title="ForInAndRanges.gs"
package Tour.ControlFlow.ForInAndRanges

import System

func Main() {
    var nums = []int32{10, 20, 30, 40}
    for v in nums[1..^1] {
        Console.WriteLine(v)
    }

    let last = nums[^1]
    let middleRange = 1..3
    let middle = nums[middleRange]

    Console.WriteLine(last)
    Console.WriteLine(middle.Length)
}
```

## While and do-while

`while cond { ... }` evaluates `cond` first and runs the body while it is true. `do { ... } while cond` is the post-test variant: the body always runs at least once.

```gsharp title="WhileDo.gs"
package Tour.ControlFlow.WhileDo

import System

func Main() {
    var i = 0
    while i < 3 {
        Console.WriteLine(i)
        i++
    }

    var j = 5
    do {
        Console.WriteLine(j)
        j++
    } while j < 5
}
```

## Labels, labeled break/continue, and `goto`

Loops can be prefixed with a `label:` declaration. `break label` and `continue label` jump out of or continue the named enclosing loop. General labels can also be targets for `goto`.

```gsharp title="LabelsAndGoto.gs"
package Tour.ControlFlow.LabelsAndGoto

import System

func Main() {
    var i = 0

again:
    i++
    if i < 3 {
        goto again
    }

outer: for row in 1...3 {
        for col in 1...3 {
            if row == 2 && col == 2 {
                break outer
            }
            Console.WriteLine(row)
            Console.WriteLine(col)
        }
    }
}
```

Unknown `goto` labels report `GS0469`; duplicate labels in a function report `GS0470`.

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

func Main() {
    describe(-5)
    describe(0)
    describe(7)
    describe(250)
}
```

## Switch expressions and patterns

Switch expressions use `case ...:` arms and produce a value. Patterns include constants, relational forms, discard, type patterns, property patterns, and list patterns.

```gsharp title="SwitchExpression.gs"
package GSharp.Samples.SwitchExpression

import System

func Main() {
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
}
```

## Smart casts (flow narrowing)

After a successful `is` or `!is` test against a local, parameter, or read-only top-level `let`, G# automatically narrows the receiver to the tested type for the rest of the flow region.

```gsharp title="SmartCasts.gs"
package Tour.ControlFlow.SmartCasts

import System

open class Animal {
    var Name string
}

class Dog : Animal {
    func Bark() string { return Name + ": woof" }
}

class Cat : Animal {
    func Purr() string { return Name + ": purr" }
}

func Speak(a Animal) {
    if a is Dog {
        Console.WriteLine(a.Bark())
    }
}

func SpeakOrSilent(a Animal) {
    if a !is Dog {
        return
    }
    Console.WriteLine(a.Bark())
}

func GreetOrSilent(a Animal, silent bool) {
    if !(a is Dog) || silent {
        return
    }
    Console.WriteLine(a.Bark())
}

func Describe(a Animal) string {
    switch a {
        case d is Dog { return a.Bark() }
        case c is Cat { return a.Purr() }
        default { return a.Name }
    }
}
```

Reassignment to a narrowed receiver inside the narrowed region drops the narrowing for the remainder of the region. Fields, properties, and indexed expressions are never narrowed because their reads are not idempotent.

Next: [Tour: Concurrency](/docs/tour/concurrency).
