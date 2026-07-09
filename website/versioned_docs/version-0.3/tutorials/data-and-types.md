---
title: "Tutorial: Data and types"
sidebar_position: 3
draft: false
---

# Tutorial: Data and types

In this tutorial, you will work through G#'s everyday data shapes: zero values, structs and classes, data structs, inline value wrappers, arrays, slices, maps, and nullable references.

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
// Combines class declarations, primary constructors, nullable types,
// null-conditional access, null assertions, and string interpolation.

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
Console.WriteLine(hit?.Display() ?? "no match")

var miss = book.Find("Zoe")
Console.WriteLine(miss?.Display() ?? "no match")

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

`Contact?` means the function can return `nil`. Use `?.` to call only when non-nil, `?[i]` to index only when non-nil, `??` to provide a fallback, and `!!` when you want a runtime assertion that the value is present.

## 3. Use data structs for structural values

A `data struct` is a value aggregate with structural equality and copy/update ergonomics:

```gsharp title="DataStructErgonomics.gs"
// file: DataStructErgonomics.gs
// Demonstrates data-struct copy, with-expression, and deconstruction ergonomics.

package GSharp.Example.DataStructErgonomics

import System

data struct Point {
    var x int32
    var y int32
}

let p = Point{x: 3, y: 4}
let same = p.copy()
let movedX = p.copy(x: 10)
let movedBoth = p.copy(x: 10, y: 20)
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

## 4. Use a minimal data struct

The smaller `DataStruct` sample shows synthesized string and equality behavior:

```gsharp title="DataStruct.gs"
// file: DataStruct.gs
// Demonstrates a value-typed aggregate whose instances compare with
// structural equality.

package GSharp.Example.DataStruct

import System

data struct Point {
    var X int32
    var Y int32
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

## 5. Wrap values with inline structs

An `inline struct` is a readonly single-field value wrapper, useful for nominal IDs without class allocation:

```gsharp title="InlineStruct.gs"
// file: InlineStruct.gs
// Demonstrates readonly single-field value wrappers for zero-allocation newtypes.

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

## 6. Choose arrays, slices, and maps

Fixed arrays use `[N]T`. Slices use `[]T`, expose `.Length`, and are backed by CLR arrays. Use CLR collections such as `List[T]` when you need growable storage; CLR collections can use collection initializers:

```gsharp title="Slices.gs"
// file: Slices.gs
// Demonstrates variable-length slice types, composite literals, indexing, and
// growable CLR lists.

package GSharp.Example.Slices

import System
import System.Collections.Generic

var nums = []int32{10, 20, 30}
Console.WriteLine(nums.Length)
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

var sum = 0
for i in 0 ... nums.Length {
    sum = sum + nums[i]
}

Console.WriteLine(sum)

var words = List[string]{"alpha", "beta", "gamma"}
Console.WriteLine(words.Count)
Console.WriteLine(words[0])
Console.WriteLine(words[2])

Console.WriteLine("hello".Length)
```

Expected output:

```text
3
10
20
30
60
3
alpha
gamma
5
```

Fixed arrays are useful when the length is part of the type:

```gsharp title="Arrays.gs"
// file: Arrays.gs
// Demonstrates fixed-length array types, composite literals, index read, and indexed assignment.

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

For maps, use `map[K,V]` for the G# map type or import `System.Collections.Generic` and use CLR `Dictionary[K, V]`, as shown in [Projects and packages](./project-and-packages).

## What you learned

- `var x T` starts at the type's zero value.
- Classes are reference-like; structs are value-like.
- `data struct` creates structural value aggregates.
- `inline struct` creates a nominal single-field wrapper.
- Arrays, slices, maps, nullable values, and CLR collections compose with ordinary G# control flow.
