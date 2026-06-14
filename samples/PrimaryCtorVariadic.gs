// file: PrimaryCtorVariadic.gs
// ADR-0103 / issue #819 — primary-constructor parameter lists accept a
// trailing variadic `name ...T`. The variadic param promotes to a `[]T`
// auto-field with the same name; call binding follows the standard
// pack / pass-through dance (see ADR-0101, ADR-0102).
//
// This sample covers the spelling matrix:
//   (1) class                     -- call-syntax + struct fields
//   (2) data class                -- with-copy / data semantics
//   (3) inline struct             -- single-field synthesis
//   (4) generic class             -- inferred element type
// and exercises pack, pass-through, and empty-pack call shapes.

package GSharp.Example.PrimaryCtorVariadic

import System

class Tags(name string, tags ...string) { }

data class Names(prefix string, items ...string)

inline struct Ids(values ...int32) { }

class Box[T](first T, rest ...T) { }

// (1) class — pack, pass-through, empty
let t = Tags("project", "a", "b", "c")
Console.WriteLine(t.name)
Console.WriteLine(t.tags.Length)

let arr = []string{"x", "y"}
let u = Tags("pass", arr)
Console.WriteLine(u.tags.Length)

let v = Tags("only")
Console.WriteLine(v.tags.Length)

// (2) data class — pack
let n = Names("p", "alpha", "beta")
Console.WriteLine(n.prefix)
Console.WriteLine(n.items.Length)

// (3) inline struct — call-syntax with packing (ADR-0033 + ADR-0103)
let id = Ids(10, 20, 30)
Console.WriteLine(id.values.Length)

// (4) generic class — element-type inference
let b = Box[int32](1, 2, 3, 4)
Console.WriteLine(b.first)
Console.WriteLine(b.rest.Length)
Console.WriteLine(b.rest[2])
