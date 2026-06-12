---
title: "Tutorial: Data and types"
sidebar_position: 3
draft: false
---

# Tutorial: Data and types

In this tutorial, you will work through G#'s everyday data shapes: zero values, structs and classes, data structs, records, inline value wrappers, arrays, slices, maps, and nullable references.

## Prerequisites

- A working G# project.
- The ability to run checked-in samples with the SDK or compiler-emitted path.

## 1. Declare variables and observe zero values

A `var` declaration can omit the initializer when it has an explicit type. The variable starts with that type's zero value:

```gsharp title="ZeroValues.gs"
// file: ZeroValues.gs
// Demonstrates `var` declarations without an initializer. When an explicit type
// clause is present the variable takes that type's default (zero) value, and it
// can be assigned afterwards.

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

Expected output:

```text
x=0 flag=False text=[]
x=42 flag=True text=[set]
```

Use `let` when a binding should not be reassigned, and `var` when later assignment is intentional.

## 2. Pick structs or classes

Plain structs are value-like aggregates. Classes are reference-like aggregates with methods, constructors, inheritance, properties, events, and CLR interop. The `AddressBook` sample uses classes and nullable return values to model lookup:

```gsharp title="AddressBook.gs"
// file: AddressBook.gs
// Phase 3 exit sample. Combines class declarations with primary constructors
// and instance methods (3.B.3 / ADR-0017), nullable types (3.C.1 / ADR-0020),
// the nil literal (3.C.2), the Elvis (?:) and null-assertion (!!) operators
// (3.C.3), the null-conditional access operator (3.C.3b), and string
// interpolation (1.1 / ADR-0011). The lookup helper returns a nullable
// `Contact?` so callers can choose between Elvis-default and the
// "I-know-this-is-present" assertion. Runs through the conformance harness
// on the emit backend; the interpreter exercises the same constructs in
// Phase 3.C unit tests.

package GSharp.Example.AddressBook

import System

class Contact(Name string, Email string) {
    func Display() string {
        return "$Name <$Email>"
    }
}

class Book(First Contact, Second Contact, Third Contact) {
    func Find(name string) Contact? {
        if First.Name == name {
            return First
        }
        if Second.Name == name {
            return Second
        }
        if Third.Name == name {
            return Third
        }
        return nil
    }
}

var book = Book(
    Contact("Alice", "alice@example.com"),
    Contact("Bob", "bob@example.com"),
    Contact("Carol", "carol@example.com"))

var hit = book.Find("Bob")
Console.WriteLine(hit?.Display() ?: "no match")

var miss = book.Find("Zoe")
Console.WriteLine(miss?.Display() ?: "no match")

// `!!` asserts non-null and lets us reach members on the result directly.
var forced = book.Find("Alice")!!
Console.WriteLine(forced.Display())
```

Expected output:

```text
Bob <bob@example.com>
no match
Alice <alice@example.com>
```

`Contact?` means the function can return `nil`. Use `?.` to call only when non-nil, `?[i]` to index only when non-nil (lifts to nullable; ADR-0073), `?:` to provide a fallback, and `!!` when you want a runtime assertion that the value is present.

## 3. Use data structs for structural values

A `data struct` is a value aggregate with structural equality and copy/update ergonomics:

```gsharp title="DataStructErgonomics.gs"
// file: DataStructErgonomics.gs
// Phase 7.3 / ADR-0032: data-struct copy, with-expression, and deconstruction ergonomics.

package GSharp.Example.DataStructErgonomics

import System

data struct Point {
    x int32
    y int32
}

let p = Point{x: 3, y: 4}
let same = p.copy()
let movedX = p.copy(x = 10)
let movedBoth = p.copy(x = 10, y = 20)
let viaWith = p with { x = 10 }
let (px, py) = p
let { y = namedY, x = namedX } = movedBoth

Console.WriteLine(p == same)
Console.WriteLine(movedX == viaWith)
Console.WriteLine(movedBoth.x)
Console.WriteLine(movedBoth.y)
Console.WriteLine(px + py)
Console.WriteLine(namedX + namedY)
```

Expected output:

```text
True
True
10
20
7
30
```

The `.copy(...)` call and `with` expression produce modified values without mutating the original. Tuple and named deconstruction read fields from a data struct.

## 4. Use records as a familiar alias

`record` is a contextual alias for `data struct`, not a separate runtime kind:

```gsharp title="Records.gs"
// file: Records.gs
// Phase 6.7 / ADR-0025: 'record' is a context-sensitive alias for
// 'data struct'. This sample intentionally mirrors DataStruct.gs with the
// same observable structural-equality behavior.

package GSharp.Example.Records

import System

data struct Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = Point{X: 3, Y: 4}
var r = Point{X: 3, Y: 5}

Console.WriteLine(p == q)
Console.WriteLine(p != r)
Console.WriteLine(q == r)

var s = p
s.X = 99
Console.WriteLine(p == s)
```

Expected output:

```text
True
True
False
False
```

Choose the spelling that best communicates with your team. The compiler binds both forms to the same data-struct semantics.

## 5. Use a minimal data struct

The smaller `DataStruct` sample shows synthesized string and equality behavior:

```gsharp title="DataStruct.gs"
// file: DataStruct.gs
// Phase 3.B.2 / ADR-0029: 'data struct' declarations introduce a value-typed
// aggregate whose instances compare with structural equality. The 'data'
// keyword is context-sensitive (only special before 'struct') and the
// compiled CLR type is a plain ValueType whose inherited reflection-based
// Equals/GetHashCode delivers the same semantics as the interpreter's
// field-by-field comparison.

package GSharp.Example.DataStruct

import System

data struct Point {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
var q = Point{X: 3, Y: 4}
var r = Point{X: 3, Y: 5}

Console.WriteLine(p == q)
Console.WriteLine(p != r)
Console.WriteLine(q == r)

var s = p
s.X = 99
Console.WriteLine(p == s)
```

Expected output:

```text
True
True
False
False
```

## 6. Wrap values with inline structs

An `inline struct` is a readonly single-field value wrapper, useful for nominal IDs without class allocation:

```gsharp title="InlineStruct.gs"
// file: InlineStruct.gs
// Phase 7.4 / ADR-0033: 'inline struct' declarations introduce readonly single-field value wrappers for zero-allocation newtypes.

package GSharp.Example.InlineStruct

import System

inline struct UserId(value string)
inline struct OrderId(value string)

func printUser(id UserId) {
    let (raw) = id
    Console.WriteLine("UserId(value=" + raw + ")")
}

let user = UserId("u-1")
let sameUser = UserId("u-1")
let order = OrderId("o-1")
let echoed = user
let (rawUser) = user
let (rawOrder) = order

printUser(user)
Console.WriteLine(user == sameUser)
Console.WriteLine(user != echoed)
Console.WriteLine(rawUser)
Console.WriteLine(rawOrder)
```

Expected output:

```text
UserId(value=u-1)
True
False
u-1
o-1
```

`UserId` and `OrderId` both wrap strings, but they are different G# types.

## 7. Choose arrays, slices, and maps

Fixed arrays use `[N]T`. Slices use `[]T`, support `len`, `cap`, and `append`, and are backed by CLR arrays:

```gsharp title="Slices.gs"
// file: Slices.gs
// Demonstrates Phase 3.A.2 emit coverage: variable-length slice types,
// composite literals, indexing, and the len / cap / append intrinsics.

package GSharp.Example.Slices

import System

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))
Console.WriteLine(cap(nums))
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

nums = append(nums, 40)
Console.WriteLine(len(nums))
Console.WriteLine(nums[3])

var sum = 0
for i in 0 ... len(nums) {
    sum = sum + nums[i]
}

Console.WriteLine(sum)

var words = []string{"alpha"}
words = append(words, "beta")
words = append(words, "gamma")
Console.WriteLine(len(words))
Console.WriteLine(words[0])
Console.WriteLine(words[2])

Console.WriteLine(len("hello"))
```

Expected output:

```text
3
3
10
20
30
4
40
100
3
alpha
gamma
5
```

Fixed arrays are useful when the length is part of the type:

```gsharp title="Arrays.gs"
// file: Arrays.gs
// Demonstrates Phase 3.A.1 / 3.A.3 emit coverage: fixed-length array types,
// composite literals, index read, and indexed assignment.

package GSharp.Example.Arrays

import System

var nums = [3]int32{10, 20, 30}
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

nums[1] = 99
Console.WriteLine(nums[1])

var names = [2]string{"alpha", "beta"}
Console.WriteLine(names[0])
Console.WriteLine(names[1])

var sum = 0
for i in 0 ... 3 {
    sum = sum + nums[i]
}

Console.WriteLine(sum)
```

Expected output:

```text
10
20
30
99
alpha
beta
139
```

For maps, use `map[K]V` for the G# map type or import `System.Collections.Generic` and use CLR `Dictionary[K, V]`, as shown in [Projects and packages](./project-and-packages).

## What you learned

- `var x T` starts at the type's zero value.
- Classes are reference-like; structs are value-like.
- `data struct` and `record` are structural value aggregates.
- `inline struct` creates a nominal single-field wrapper.
- Arrays, slices, maps, nullable values, and CLR collections compose with ordinary G# control flow.
