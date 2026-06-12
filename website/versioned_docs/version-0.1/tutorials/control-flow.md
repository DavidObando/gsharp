---
title: "Tutorial: Control flow"
sidebar_position: 4
draft: false
---

# Tutorial: Control flow

In this tutorial, you will write G# branches, loops, switches, and patterns. G# keeps Go-like `if` and `for` syntax, adds expression switches, and deliberately does not support fallthrough.

## Prerequisites

- A working G# project.
- Familiarity with arrays, slices, and data structs from [Data and types](./data-and-types).

## 1. Count with `for`

G# does not have a `while` keyword. Use `for condition` for while-shaped loops, or a C-style header when you need init and post clauses:

```gsharp title="Loop.gs"
// file: Loop.gs
// Demonstrates statements added across Phases 1 and 2: implicit
// `import System` (Phase 1.5), string interpolation (Phase 1.1),
// the C-style `for init; cond; post { … }` clause form (Phase 2.4),
// and the `i--` decrement statement (Phase 2.2). This is the v0.1
// design — see `design/Gsharp-design-v0.1.md` and ADR-0010.

package GSharp.Example.Loop

import System

var count = 5

for i := count; i > 0; i-- {
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

type NumberEnumerator class(Index int32, Current int32) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

type Numbers class {
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

The older `for v := range collection` spelling still works for compatibility, but new docs and samples prefer `for v in collection`.

## 3. Use `if` for local decisions

The `CountWords` sample combines `if`, dictionary lookup, and loops to count words:

```gsharp title="CountWords.gs"
// file: CountWords.gs
//
// Phase 4 exit sample. Exercises the CLR-interop features that landed
// across PRs #62–#65 in one cohesive program:
//
//   - `Dictionary[K, V]` instantiation via the generic BCL type-position
//     resolver (Phase 4.4 / ADR-0020) and the CLR constructor-call
//     binder (Phase 4 exit, part 1).
//   - Indexer read/write on a CLR map (`counts[w]`) and instance method
//     calls (`counts.ContainsKey(w)`) via the CLR member-access binder
//     (Phase 4 exit, part 2).
//   - Range iteration over both an array (`for w := range words`) and a
//     CLR `IDictionary[K, V]` (`for k, v := range counts`) via the
//     for-range lowerer (Phase 4 exit, part 3).
//   - Cross-feature use of string interpolation (Phase 1.1) and the
//     fixed-size array literal syntax (Phase 3.A.2).
//
// Runs on both backends. Originally landed under `samples/aspirational/`
// (PR #66) because the emit pipeline could not yet encode CLR
// constructors / member access / for-range. The emit-parity work in PRs
// #67+ closes that gap, so this sample is now part of the top-level
// emit conformance harness (SampleConformanceTests) in addition to its
// interpreter-side sibling CountWordsSampleTests.

package GSharp.Example.CountWords

import System
import System.Collections.Generic

var words = [12]string{
    "the", "quick", "brown", "fox", "jumps", "over",
    "the", "lazy", "dog", "the", "quick", "fox",
}

var counts = Dictionary[string, int32]()

for w := range words {
    if counts.ContainsKey(w) {
        counts[w] = counts[w] + 1
    } else {
        counts[w] = 1
    }
}

for k, v := range counts {
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

## 4. Use switch statements when each arm performs work

Switch cases have block bodies and never fall through. If two cases should do the same work, factor the body into a helper or repeat it deliberately.

```gsharp title="PatternSwitch.gs"
// file: PatternSwitch.gs
//
// Phase B (close interpreter/emit gap): pattern-switch *statement* emit.
// Exercises constant, discard, relational, type, property, and list patterns
// end-to-end through gsc.

package GSharp.Samples.PatternSwitch

import System

type Animal open class { Name string }
type Dog class : Animal { Bark int32 }
type Cat class : Animal { Purr int32 }

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

type Point data struct { X int32 Y int32 }

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

## 5. Use switch expressions when each arm returns a value

Switch expressions use `->` arms:

```gsharp title="SwitchExpression.gs"
// file: SwitchExpression.gs
//
// Phase C (close interpreter/emit gap): switch *expression* emit.
// Exercises constant, discard, type, property, relational, and list
// pattern arms all returning a unified result type.

package GSharp.Samples.SwitchExpression

import System

type Shape open class { Name string }
type Circle class : Shape { Radius int32 }
type Square class : Shape { Side int32 }

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

func areaTag(s Shape) string {
  return switch s {
    case c is Circle: "circle"
    case sq is Square: "square"
    default: "shape"
  }
}

Console.WriteLine(areaTag(Circle{Name: "c", Radius: 1}))
Console.WriteLine(areaTag(Square{Name: "s", Side: 2}))

let xs = []int32{1, 2, 3}
let listLabel = switch xs {
  case [1, _, 3]: "bookended"
  case _: "other"
}
Console.WriteLine(listLabel)

type Pair data struct { A int32 B int32 }
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

## 6. Try a compact pattern example

Some pattern features originated on the interpreter path. The `Patterns` sample remains useful as the shortest expression-switch walkthrough:

```gsharp title="Patterns.gs"
// file: aspirational/Patterns.gs
//
// Phase 6.2 sample. Pattern matching is interpreter-only for now;
// emit is deferred with the same posture as Phase 5 surfaces.

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
- Prefer `for x in xs` over legacy range spelling.
- Switch cases do not fall through, and `fallthrough` is reserved only for a clear diagnostic.
- Patterns work in both switch statements and switch expressions.
