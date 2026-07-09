---
title: "Tutorial: Control flow"
sidebar_position: 4
draft: false
---

# Tutorial: Control flow

In this tutorial, you will write G# branches, loops, switches, and patterns. G# keeps compact `if` and `for` syntax, adds expression switches, and deliberately does not support fallthrough.

## Prerequisites

- A working G# project.
- Familiarity with arrays, slices, and data structs from [Data and types](./data-and-types).

## 1. Count with `for`

G# supports `for`, `while`, and `do`-`while`. The `for` family remains the most common choice for indexed loops; use a C-style header when you need init and post clauses:

```gsharp title="Loop.gs"
// file: Loop.gs
// Demonstrates implicit `import System`, string interpolation,
// the C-style `for init; cond; post { … }` clause form, and
// the `i--` decrement statement.

package GSharp.Example.Loop

import System

var count = 5

for var i = count; i > 0; i-- {
    Console.WriteLine("Count value: $i")
}
```

Expected output:

```text
Count value: 5
Count value: 4
Count value: 3
Count value: 2
Count value: 1
```

A range-like integer loop can use `start ... end`, as shown in the slice and array samples.

## 2. Iterate collections with `for in`

The canonical collection iteration form is `for value in collection`. Dictionaries can bind key and value:

```gsharp title="ForIn.gs"
import System
import System.Collections.Generic

class NumberEnumerator(Index int32, Current int32) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

class Numbers {
    func GetEnumerator() NumberEnumerator {
        return NumberEnumerator(0, 0)
    }
}

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

var list = List[int32]()
list.Add(4)
list.Add(5)
for v in list {
    Console.WriteLine(v)
}

for v in Numbers{} {
    Console.WriteLine(v)
}
```

Expected output:

```text
1
2
3
one
1
two
2
4
5
2
4
6
```



## 3. Use `if` for local decisions

The `CountWords` sample combines `if`, dictionary lookup, and loops to count words:

```gsharp title="CountWords.gs"
// file: CountWords.gs
// Exercises dictionary construction, indexer read/write, collection iteration,
// and string interpolation in one program.

package GSharp.Example.CountWords

import System
import System.Collections.Generic

var words = [12]string{
    "the", "quick", "brown", "fox", "jumps", "over",
    "the", "lazy", "dog", "the", "quick", "fox",
}

var counts = Dictionary[string, int32]()

for w in words {
    if counts.ContainsKey(w) {
        counts[w] = counts[w] + 1
    } else {
        counts[w] = 1
    }
}

for k, v in counts {
    Console.WriteLine("$k: $v")
}
```

Expected output:

```text
the: 3
quick: 2
brown: 1
fox: 2
jumps: 1
over: 1
lazy: 1
dog: 1
```

## 4. Use `if` as a value

When a branch picks a value rather than a side-effecting action, `if` can also sit in expression position. The form supports `else if` chains and multi-statement blocks whose trailing expression is the branch value:

```gsharp
let pct = 85
let grade = if pct >= 90 { "A" }
           else if pct >= 80 { "B" }
           else if pct >= 70 { "C" }
           else { "F" }
Console.WriteLine(grade)
```

Rules:

- A value-position `if` MUST end in `else` (`GS0276`). If you do not need a value, use the statement form (`if cond { … }`).
- Each branch is a block. The block's **last expression** becomes its value — there is no `yield` keyword. An empty block reports `GS0277`.
- Branch tails are unified by the same common-type rule as ternary expressions; mismatched branches report `GS0263`.
- Only the chosen branch runs — the other arms are not evaluated.

The complete worked example lives under `samples/IfExpression.gs`.

## 5. Use switch statements when each arm performs work

Switch cases have block bodies and never fall through. If two cases should do the same work, factor the body into a helper or repeat it deliberately.

```gsharp title="PatternSwitch.gs"
// file: PatternSwitch.gs
//
// Phase B (close interpreter/emit gap): pattern-switch *statement* emit.
// Exercises constant, discard, relational, type, property, and list patterns
// end-to-end through gsc.

package GSharp.Samples.PatternSwitch

import System

open class Animal { var Name string }
class Dog : Animal { var Bark int32 }
class Cat : Animal { var Purr int32 }

func describe(n int32) {
  switch n {
    case 0 { Console.WriteLine("zero") }
    case < 0 { Console.WriteLine("negative") }
    case > 100 { Console.WriteLine("huge") }
    default { Console.WriteLine("positive small") }
  }
}

func name(a Animal) {
  switch a {
    case d is Dog { Console.WriteLine("dog ${d.Name} barks ${d.Bark}") }
    case c is Cat { Console.WriteLine("cat ${c.Name} purrs ${c.Purr}") }
    default { Console.WriteLine("unknown") }
  }
}

func shape(xs []int32) {
  switch xs {
    case [1, _, 3] { Console.WriteLine("bookended-3") }
    case [_] { Console.WriteLine("singleton") }
    default { Console.WriteLine("other") }
  }
}

data struct Point { var X int32 var Y int32 }

func origin(p Point) {
  switch p {
    case { X: 0, Y: 0 } { Console.WriteLine("origin") }
    case { X: > 0, Y: > 0 } { Console.WriteLine("Q1") }
    default { Console.WriteLine("elsewhere") }
  }
}

describe(-5)
describe(0)
describe(7)
describe(250)
name(Dog{Name: "rex", Bark: 9})
name(Cat{Name: "ed", Purr: 4})
shape([]int32{1, 2, 3})
shape([]int32{42})
shape([]int32{9, 9})
origin(Point{X: 0, Y: 0})
origin(Point{X: 3, Y: 4})
origin(Point{X: -1, Y: 1})
```

Expected output:

```text
negative
zero
positive small
huge
dog rex barks 9
cat ed purrs 4
bookended-3
singleton
other
origin
Q1
elsewhere
```

Pattern switch statements support constants, relational patterns, type patterns, list patterns, discard patterns, and data-struct property patterns.

## 6. Use switch expressions when each arm returns a value

Switch expressions use `->` arms:

```gsharp title="SwitchExpression.gs"
// file: SwitchExpression.gs
//
// Phase C (close interpreter/emit gap): switch *expression* emit.
// Exercises constant, discard, type, property, relational, and list
// pattern arms all returning a unified result type.

package GSharp.Samples.SwitchExpression

import System

open class Shape { var Name string }
class Circle : Shape { var Radius int32 }
class Square : Shape { var Side int32 }

func areaTag(s Shape) string {
  return switch s {
    case c is Circle: "circle"
    case sq is Square: "square"
    default: "shape"
  }
}

data struct Pair { var A int32 var B int32 }

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

Console.WriteLine(areaTag(Circle{Name: "c", Radius: 1}))
Console.WriteLine(areaTag(Square{Name: "s", Side: 2}))

let xs = []int32{1, 2, 3}
let listLabel = switch xs {
  case [1, _, 3]: "bookended"
  case _: "other"
}
Console.WriteLine(listLabel)

let p = Pair{A: 7, B: 7}
let pairLabel = switch p {
  case { A: 0, B: 0 }: "origin"
  case { A: 7, B: 7 }: "diag77"
  default: "other"
}
Console.WriteLine(pairLabel)
```

Expected output:

```text
-3 -> neg
0 -> zero
1 -> small-pos
5 -> small-pos
101 -> huge
circle
square
bookended
diag77
```

A `default` arm is the easiest way to make the result total.

## 7. Try a compact pattern example

Some pattern features originated on the interpreter path. The `Patterns` sample remains useful as the shortest expression-switch walkthrough:

```gsharp title="Patterns.gs"
// file: aspirational/Patterns.gs
//
// Short expression-switch walkthrough using relational and list patterns.

package GSharp.Samples.Patterns

import System

let number = 7
let numericLabel = switch number {
  case < 0: "negative"
  case > 0: "positive"
  default: "zero"
}

let values = []int32{1, 2, 3}
let listLabel = switch values {
  case [1, _, 3]: "bookended"
  case _: "other"
}

Console.WriteLine("$numericLabel / $listLabel")
```

Expected output:

```text
positive / bookended
```

## What you learned

- Use `for` for infinite, condition, counted, and collection loops.
- Use `for x in xs` for collection iteration.
- Switch cases do not fall through, and `fallthrough` is reserved only for a clear diagnostic.
- Patterns work in both switch statements and switch expressions.
