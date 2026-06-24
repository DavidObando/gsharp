---
title: "Language specification"
sidebar_position: 1
draft: false
---

# Language specification

## Introduction

G# is a Go-inspired language implemented for the .NET CLR. It uses Go-like packages, imports, functions, structs, slices, maps, channels, `go`, `select`, `defer`, and `range`-style iteration, while adding CLR classes, interfaces, properties, events, attributes, delegates, exceptions, `async`/`await`, iterators, and direct PE/PDB emission. This specification describes the language as implemented today by the shared lexer, parser, binder, lowerer, emitter, and interpreter. When the emit path and interpreter differ, the difference is called out explicitly.

The grammar fragments use EBNF. Terminals are quoted. `identifier`, `number`, `string`, and `char` denote lexical tokens. Brackets in grammar productions are literal when quoted; otherwise `[...]` means optional and `{...}` means repetition. G# does not implement Go-style automatic semicolon insertion; separators are the tokens shown in the productions.

## Source code representation

Source files are Unicode text. The compiler consumes source through .NET strings; in normal use files are UTF-8. Line terminators are LF, CR, or CRLF. Outside strings, whitespace is insignificant except where it separates tokens. Comments and whitespace are skipped before parsing.

A compilation unit consists of an optional package declaration, zero or more imports, and declarations or top-level statements. The production compiler path is `gsc` with an `/out:` option, which emits managed assemblies and optional Portable PDBs. Without `/out:`, `gsc` uses the interpreter path. Both paths share parsing and binding, but features involving metadata emission, state machines, and byref/pointer interop are most complete in the emit path.

## Lexical elements

### Comments

Line comments begin with `//` and run to the end of the line. Block comments begin with `/*` and end with `*/`; they do not nest. An unterminated block comment is a lexical diagnostic. Documentation comments begin with `///` and run to the end of the line; consecutive `///` lines are concatenated, the first leading space is stripped, and the block is attached to the following declaration where it is parsed as Markdown and lowered to CLR XML doc. See [Documentation comments](#documentation-comments).

### Tokens

The lexer produces identifiers, reserved keywords, literal tokens, punctuation and operators, comments, whitespace, bad tokens, and EOF. The fixed operator and punctuation tokens are:

```text
+  +=  ++  -  -=  --  *  *=  /  /=  %  %=  (  )  [  ]  {  }
:  ;  ,  .  ...  ^  ^=  &  &&  &=  &^  &^=  |  |=  ||
=  ==  !  !=  !!  ?  ?.  ?[  ??  ??=  <  <=  <-  ->  <<  <<=  >  >=  >>  >>=  @
```

The `:=` sequence is still lexed (as `ColonEqualsToken`) for diagnostic
purposes — the parser hard-rejects every occurrence with `GS0305` per
ADR-0077 — but the operator has no role in the grammar.

### Identifiers

Identifiers start with a Unicode letter or `_` and continue with Unicode letters, Unicode digits, or `_`. The implementation uses .NET `char.IsLetter` and `char.IsLetterOrDigit`, so names such as `café`, `π`, and `_value2` are valid. Identifiers represented only by surrogate pairs are not currently accepted as identifier characters.

```ebnf
identifier = letter { letter | unicode_digit } .
letter     = unicode_letter | "_" .
```

### Keywords

The reserved keywords are:

```text
as async await break case catch chan class const continue default defer do else enum false fallthrough finally for func go goto guard if import interface internal is let map nil open operator override package private protected public range return scope sealed select sequence struct switch throw true try type using var while
```

Several words are contextual rather than reserved. `data`, `inline`, `prop`, `event`, `shared`, `init`, `get`, `set`, `add`, `remove`, `raise`, `in`, `out`, `yield`, `with`, `typeof`, `nameof`, and `make` retain identifier status except in the grammar contexts described below. The legacy `record` contextual keyword was removed by ADR-0078; the lexer still recognises it so the parser can emit the GS0307 migration diagnostic (`use data struct` / `data class`).

### Operators and punctuation

Compound assignment recognizes `+=`, `-=`, `*=`, `/=`, `%=`, `^=`, `&=`, `|=`, `&^=`, `<<=`, and `>>=`. The parser rewrites these as assignment with the corresponding binary operator. `++` and `--` are statement forms on identifiers. The null-coalescing compound assignment `??=` (ADR-0072) writes the right-hand side into the left only when the lvalue currently reads as nil; see [Null-coalescing compound assignment](#null-coalescing-compound-assignment--adr-0072) under *Statements*. The `..` range operator slices a sliceable value inside an indexer (`a[lo..hi]`) and also forms a standalone `System.Range` value (`let r = 1..3`; issue #1038), and a leading `^n` marks a from-end index (`a[^1]`, `a[1..^1]`); see [Range and slice expressions](#range-and-slice-expressions-issue-1016). `@` begins annotations on declarations.

### Integer literals

Integer literals may be decimal, hexadecimal, octal, or binary. Underscores may appear in digit bodies, including immediately after a base prefix, but not as the final digit and not as the only digit after a prefix.

| Form | Prefix | Digits | Example |
| --- | --- | --- | --- |
| Decimal | none | `0` through `9` | `42`, `1_000` |
| Hexadecimal | `0x` or `0X` | hex digits | `0xFF`, `0x_DEAD_BEEF` |
| Octal | `0o` or `0O` | `0` through `7` | `0o755`, `0O_77` |
| Binary | `0b` or `0B` | `0` and `1` | `0b1010`, `0B_1010` |

Unsuffixed decimal integers default to `int32`. Non-decimal values that fit `uint32` are bit-cast to `int32` for compatibility. Integer suffixes are case-insensitive: `L` selects `int64`, `U` selects `uint32`, and `UL` or `LU` selects `uint64`.

### Floating-point literals

Floating-point literals are decimal-radix only. Accepted forms include `1.5`, `.5`, `1e10`, and `1.5e-3`. A digit must follow the dot, so `1.` is tokenized as an integer followed by `.` rather than a float. Unsuffixed float literals default to `float64`. Suffixes are case-insensitive: `F` selects `float32`, `D` selects `float64`, and `M` selects `decimal`.

### Character literals

Character literals are single-quoted and represent exactly one UTF-16 code unit or escape. Supported escapes are `\'`, `\"`, `\\`, `\0`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v`, `\x` with one to four hex digits, `\u` with exactly four hex digits, and `\U` with exactly eight hex digits constrained to a single UTF-16 code unit. Empty literals, multiple-code-unit literals, malformed escapes, and out-of-range Unicode escapes are diagnostics.

### String literals

Normal string literals are delimited by double quotes. In the current compiler lexer, the escape-like form for a literal quote inside a normal string is doubled quotes, as in `"a ""quoted"" word"`; backslash escapes are not interpreted by the normal string lexer. Raw strings are delimited by backticks, may span lines, do not process escapes or interpolation, normalize CR and CRLF to LF in their value, and cannot contain a backtick.

Interpolation is sigil-free: holes live inside ordinary double-quoted strings, not behind a C#-style `$"…"` prefix. A hole is either `$name`, which captures a single identifier, or a braced `${expression}`. Use `$$` for a literal dollar sign. There is no `{{`/`}}` brace escaping; a literal brace is just a brace. Braced interpolation parses the captured expression text as a fresh expression syntax tree whose tokens carry absolute source spans, so IDE features (hover, go-to-definition, find-references, completion, signature help) work inside a hole.

A braced hole may carry an optional alignment and format clause: `${expr,alignment}`, `${expr:format}`, or `${expr,alignment:format}`. The alignment is a constant integer (negative for left-justify), and the format is a standard .NET format string. The `,` and `:` separators are recognized only at the top level of the hole.

```gsharp title="samples/InterpolatedString.gs"
package InterpolatedString

let name = "world"
let n = 6
Console.WriteLine("Hello, $name!")
Console.WriteLine("answer = ${n * 7}")
Console.WriteLine("$$ stays literal")
```

The `${…}` scanner is delimiter-aware. It tracks `()`, `[]`, and `{}` nesting, skips over nested `"…"` and `'…'` literals and `//` and `/* */` comments, and allows the hole expression to span multiple lines. Consequently `${dict["k"]}`, `${cond ? "a" : "b"}`, and a hole whose expression wraps onto a second line all lex correctly, and a `,` or `:` inside a nested string is never mistaken for an alignment or format clause.

```gsharp title="samples/InterpolatedStringRichHoles.gs"
let n = 6
Console.WriteLine("greeting=${"hello"}")
Console.WriteLine("len=${"a,b:c".Length}")
Console.WriteLine("answer=${n *
7}")
```

Malformed interpolation is reported by dedicated diagnostics: `GS0220` (non-constant alignment), `GS0221` (handler forwarding), `GS0222` (unterminated hole), `GS0223` (empty hole), `GS0224` (empty format specifier), and `GS0225` (newline in the literal portion of the string). By default an interpolated string lowers to `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler` (composite formatting in the interpreter); when its contextual target type is `IFormattable` or `FormattableString` it instead lowers to `FormattableStringFactory.Create`, deferring formatting so the caller selects the culture. See the [CLR interop reference](./clr-interop.md#interpolated-strings-and-formatting).

### Boolean and nil literals

`true` and `false` are boolean literals. `nil` is the null literal. `null` is not a keyword or literal in G#. When the identifier `null` appears in a value-expression position and no symbol named `null` exists in scope, the binder reports `GS0273` ("`'null'` is not a literal in G#. Did you mean `'nil'`?") and recovers by treating the identifier as `nil`, so target-type contexts continue to typecheck (ADR-0081). Declarations may legally name a symbol `null` (e.g. `func null() { ... }` or `let null = "hi"`); identifier resolution wins over the recovery in that case.

### `default` expressions (ADR-0100)

`default(T)` evaluates to the zero-initialised value of any type `T`: `0`/`false`/`0.0` for built-in value types, `nil` for reference types and `T?`, field-wise zero for user structs, and the runtime substitution of `T` for an unconstrained type parameter (so `default(T)` in a generic function emits `initobj T` and Just Works for both reference- and value-type substitutions per ADR-0087).

The bare `default` literal is valid in *target-typed* positions and takes its type from the surrounding context: the initializer of a `let`/`var` with an explicit type clause, the value of a `return` when the enclosing function has a known declared return type, an argument bound against a parameter of known type, and a branch of a conditional expression typed by its sibling. A bare `default` used where no target type is available is reported as `GS0362`.

The arm-leader use of `default` inside `switch`/`select` is unchanged — the parser recognises the arm leader before attempting expression parsing.

## Constants and variables

G# has `const`, `let`, and `var` declarations. A constant or `let` binding requires an initializer. A `var` binding may either have an initializer or name a type for a zero/default value.

```ebnf
VariableDecl = ( "const" | "let" | "var" ) identifier TypeClause? "=" Expression
             | "var" identifier TypeClause
             | "let" "(" identifier { "," identifier } ")" "=" Expression
             | "let" "{" identifier "=" identifier { "," identifier "=" identifier } "}" "=" Expression .
```

`let` communicates immutability of the binding. `var` introduces a mutable variable. `const` is for compile-time constants. Tuple deconstruction and named deconstruction use `let` forms. Multi-target assignment is statement syntax and is limited to identifier target lists today. The legacy `identifier ":=" Expression` short variable-declaration form was removed by ADR-0077 / issue #717; use `let name = expr` (immutable) or `var name = expr` (mutable) instead.

## Types

### Predeclared types

The predeclared primitive and special type names are `bool`, `uint8`, `int8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `nint`, `nuint`, `float32`, `float64`, `decimal`, `char`, `string`, `object`, `void`, and the special literal type `nil`. Width-bearing integer names are canonical. ADR-0098 / issue #729 additionally accepts the friendly numeric aliases `int` (→ `int32`), `uint` (→ `uint32`), `long` (→ `int64`), `ulong` (→ `uint64`), `short` (→ `int16`), `ushort` (→ `uint16`), `byte` (→ `uint8`), `sbyte` (→ `int8`), `float` (→ `float32`), and `double` (→ `float64`) in every type-clause position; the alias resolves to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, `nameof`, hover, and IL always print the canonical name. Aliases are reserved type names — a `type` / `struct` / `class` / `enum` / `delegate` declaration that tries to shadow one is rejected with `GS0102`.

### Boolean types

`bool` has values `true` and `false`. Logical operators are `!`, `&&`, and `||`. Bitwise-style boolean operators `&`, `|`, and `^` are also defined.

### Numeric types

Integral types are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `nint`, and `nuint`. Floating and decimal types are `float32`, `float64`, and `decimal`. Operators are defined per primitive type rather than by implicit cross-type promotion. Widening numeric conversions follow the implemented conversion lattice; other numeric primitive pairs require explicit conversion.

### String and character types

`string` is the CLR `System.String` type. It supports concatenation with `+` and equality with `==` and `!=`. `char` is the CLR `System.Char` type and supports comparison.

### Object and nil

`object` is the universal upper bound. Values backed by CLR types and user value types can implicitly convert or box to `object`; explicit conversions can unbox to CLR value types. Nullable types are written by appending `?` to a type clause. `nil` converts implicitly to nullable types but not to non-nullable types. Postfix `!!` asserts non-null and `??` is null coalescing.

### Arrays and slices

Fixed arrays are written `[N]T`, and slices are written `[]T`. The element type `T` is an arbitrary type clause, not just an identifier (issue #1046): it may itself be an array/slice, so jagged arrays such as `[][]uint8` (the G# spelling of C# `byte[][]`) and deeper nestings (`[][][]int32`) are allowed, as are arrays of pointers (`[]*int32`), maps (`[]map[K]V`), channels (`[]chan T`), and generic or qualified names (`[]List[int32]`, `[]Outer.Inner`). Array and slice composite literals use the same bracketed prefix with the element type, which likewise may be nested (`[][]int32{ []int32{1, 2}, []int32{3} }`):

```gsharp
let xs = []int32{1, 2, 3}
let ys = [3]int32{1, 2, 3}
let grid = [][]int32{ []int32{1, 2}, []int32{3, 4, 5} }
```

Slices are backed by CLR arrays. `len` and `cap` observe array length, and `append` allocates and copies into a new array in the current implementation. The `len`, `cap`, `append`, `delete`, and `make` built-ins are Go-style and require `import Gsharp.Extensions.Go` (ADR-0083); see [Go-style built-ins (`import Gsharp.Extensions.Go`)](#go-style-built-ins-import-gsharpextensionsgo) for the gate and the .NET-idiomatic alternatives (`.Length`, `.Count`, `.Remove(k)`, `List[T].Add`).

### Maps

Maps are written `map[K,V]` and are backed by `Dictionary<K,V>` in the implementation. Map literals use key-value entries, indexing reads values, and indexed assignment updates entries.

```gsharp
let counts = map[string,int32]{"g": 1, "sharp": 2}
```

### Sequences

`sequence[T]` is the sequence type and projects to `IEnumerable<T>`. A function returning `sequence[T]` can use `yield` to produce values. `async sequence[T]` projects to asynchronous enumeration. There is no dedicated sequence literal syntax today; use arrays, slices, iterator functions, or imported CLR sequence producers.

### Channels

Channels are written `chan T`. A channel value is created with `make(chan T)` or `make(chan T, capacity)`. Prefix receive is `<-ch`; send statements are `ch <- value`; `select` multiplexes receive and send cases. Channels are backed by `System.Threading.Channels`.

The Go-flavored channel surface — `chan T`, `<-` (send and receive), `make(chan T)`, `select`, and `close(ch)` — is gated behind a per-file `import Gsharp.Extensions.Go` (ADR-0082). Files that use any of these forms without the import get diagnostic `GS0316`.

```gsharp title="samples/Channels.gs"
package GSharp.Samples.Channels

import System
import Gsharp.Extensions.Go

let ch = make(chan int32, 3)
ch <- 1
ch <- 2
ch <- 3
close(ch)

let a = <-ch
let b = <-ch
let c = <-ch
let d = <-ch

Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(c)
Console.WriteLine(d)
```

```text title="samples/Channels.golden"
1
2
3
0
```

### Go-style built-ins (`import Gsharp.Extensions.Go`)

G# inherits a small set of Go-style built-in functions —
`len`, `cap`, `append`, `delete`, and the `make(chan T[, cap])`
constructor — that operate on the Go-flavored collection /
channel surface. Per ADR-0083 (issue #723), every built-in in
this cluster is gated behind the same per-file
`import Gsharp.Extensions.Go` as the channel surface
(ADR-0082). Files that call any of these without the import get
diagnostic `GS0317` (or `GS0316` for `make(chan T)`, anchored
at the inner `chan` clause, and for `close(ch)` — see
"Deconfliction" in ADR-0083).

| Built-in | Resolves to | .NET-idiomatic alternative |
|---|---|---|
| `len(arr)` / `len(slice)` / `len(string)` | array / slice / string length | `arr.Length` / `s.Length` |
| `len(map)` | map entry count | `m.Count` |
| `cap(slice)` | underlying-storage capacity | — (use the import) |
| `append(slice, elem)` | grow-and-copy on a slice | `List[T].Add` for mutable lists |
| `delete(map, key)` | erase a map entry | `m.Remove(k)` |
| `make(chan T[, cap])` | channel constructor (ADR-0022) | — (use the import) |
| `close(ch)` | channel-writer complete | — (use the import) |

The GS0317 diagnostic message names the offending built-in and,
where a .NET-idiomatic alternative exists, names it too — so a
file that writes `len(arr)` without the import is told "call
'.Length' directly" instead of being forced to add the import.
The recovery strategy is identical to ADR-0082's: the binder
reports GS0317 once per offending site and continues binding
the call as if the import were present, so subsequent type /
shape diagnostics still surface in the same pass.

```gsharp title="samples/Slices.gs (excerpt)"
import Gsharp.Extensions.Go

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))     // 3
Console.WriteLine(cap(nums))     // 3
nums = append(nums, 40)
Console.WriteLine(len(nums))     // 4
```

### Function types

Function types are written `(T1, T2) -> R` (ADR-0075) — fully-parenthesized parameter type list, a single `->` arrow, then a return type clause. A void-returning function uses `void` as the return type: `(T1, T2) -> void`. Multi-return shapes use a tuple return type: `() -> (T1, T2)`. Async function type clauses are written `async (T) -> R`; they represent functions returning `Task<R>` or `Task` for no result. G# function values can convert to compatible CLR delegate types. The legacy `func(T1, T2) R` and `async func(T) R` type-clause spellings continue to parse for one release; each occurrence emits a `GS0303` deprecation warning.

### Structs, classes, data classes/structs, and inline value classes

Type declarations introduce aggregates with the aggregate keyword (`class`, `struct`, `enum`, `interface`) as the head — the legacy `type Name kind` form was removed by ADR-0078 / issue #718. Structs are value-like and may declare fields, **in-body instance methods** (issue #938), properties, events, and `shared` static members; a struct in-body `func` binds as an instance method on the value type with a synthesized by-ref `this`, the same canonical, warning-free site classes use (per ADR-0079). Structs are constructed via primary constructors and struct literals; explicit `init(...)` constructors remain class-only. Classes are reference-like and can have primary constructors, explicit `init` constructors, base classes, interfaces, fields, methods, properties, events, and `shared` static members. Plain classes are sealed for inheritance unless marked `open`; overriding requires `override` and a compatible open base method. `sealed class` declares a Kotlin-style closed hierarchy (subclasses allowed in-package, exhaustiveness-bound in `switch`). Inside an instance member of a derived class, an `override` (or any other instance member) may invoke the **base class** implementation of an inherited virtual member non-virtually via the **base-class call** syntax `base.Member(args)` — the faithful mapping of C# `base.M(...)` (ADR-0091 / issue #986) — or the explicit bracketed form `base[BaseClass].Member(args)`. The call emits as `ldarg.0` followed by a non-virtual `call instance R BaseClass::Member(...)`, so the nearest base implementation runs without re-dispatching through the v-table; this lets an override delegate to the member it shadows without infinite recursion. The member is resolved by walking the base chain, so a grandparent's implementation is reached when the immediate base class does not declare its own override; parameters, generics, and return values are supported. `base.Member(...)` is valid only inside an instance member of a class that has a base class; otherwise the call is rejected with GS0383 (no base class), GS0384 (member not found on any base), or GS0385 (a `base[Type]` selector that is not the actual base class) — see the diagnostics reference. A class method MAY be declared **abstract** by giving an `open func` a `;` no-body marker instead of a `{ … }` block — `open func Area() float64;` — the canonical G# spelling of a C# `abstract` method (issue #987). An abstract method declares a virtual slot with no implementation (emitted as `MethodAttributes.Abstract | Virtual | NewSlot`, no IL body); it is only valid as an `open` member of an `open class` (otherwise GS0388). A class that declares — or inherits without overriding — an abstract method is itself **abstract**: it is emitted with `TypeAttributes.Abstract` and cannot be instantiated (constructing it is the compile error GS0386, never a runtime failure). A concrete (non-`open`) subclass must `override` every inherited abstract member (otherwise GS0387); an `open` subclass may leave them abstract and remain abstract itself. Abstract methods support parameters, generic type parameters, and reference- or value-typed (including `ref`) return types, and dispatch virtually through the base/abstract slot.

`data class` and `data struct` synthesize structural ergonomics such as equality and copy/update support; `data class` is reference-typed, `data struct` is value-typed. The `record` keyword was removed by ADR-0078; migrate to `data struct Name(...)` (or `data class Name(...)` when reference semantics are desired). `inline struct` is the inline value class form and must have exactly one field.

```gsharp title="samples/DataStruct.gs"
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
```

### Interfaces

Interfaces are declared with `interface Name { ... }` (ADR-0078). Interface members are method, property, and event signatures. A method signature MAY carry a body — a **default-interface method** (ADR-0085) — that classes implementing the interface inherit when they do not provide their own override. A body-less (abstract) interface method is terminated by `;` — the universal no-body marker for `func` declarations (issue #881), the same marker P/Invoke uses; a method carrying a `{ … }` body takes no `;`. Both abstract and default methods may appear in the same interface. An interface method MAY itself be **generic**, declaring its own type-parameter list `[T]` (or `[T, U]`) between the method name and the parameter list (issue #1007) — the same `func Name[T](...)` form class methods and free functions use. The bodyless slot binds to a generic method (arity > 0) and is emitted as a CLR generic abstract method (signature generic-parameter count plus per-method `GenericParam` rows); an implementing class supplies a same-arity generic method, and callers invoke it through an interface-typed reference with an explicit type argument (`a.Echo[int32](x)`). A same-name class method of a different generic arity does not satisfy the slot and is rejected with **GS0187**. An interface MAY also declare **static-virtual interface members** (ADR-0089) inside a `shared { … }` block on the interface — the same `shared { … }` block that hosts static members on classes and structs (ADR-0053). Inside an interface `shared` block, a body-less `func` (terminated by `;`) declares an abstract static-virtual slot that every implementer must supply; a `func` carrying a body declares a default static-virtual member that implementers MAY override but are not required to. An interface `shared` block MAY also declare a **static-virtual interface property** (ADR-0089 / issue #1019) — `prop Name T { get; }` (or `{ get; set }`, or the bare `prop Name T;` get/set form) — emitted as static-virtual `get_Name`/`set_Name` accessor slots (`Static | Virtual | Abstract`) plus a `Property` row; the implementer satisfies it with a matching static property in its own `shared { … }` block (paired to the slot by a `MethodImpl` row), and a generic method constrained by the interface reads it through `T.Name` (lowered to `constrained. !!T  call <iface>::get_Name()`). A static interface property accessor MAY also carry a **body** (issue #1030) — `prop Name T { get { … } }` — declaring a *default* static-virtual property: the accessor slots are emitted as non-abstract `Static | Virtual` methods with IL bodies, and implementers may override but are not required to (GS0396 is retired). An interface `shared` block MAY additionally declare interface static **state** (issue #1030) — `var` / `let` / `const` fields on **non-generic or generic** interfaces — emitted as real CLR `Static` FieldDef rows on the interface TypeDef (`const` as a `Static | Literal` field with a `Constant` row, reads inlined; non-`const` initializers run in a synthesized interface `.cctor`); the storage is shared interface state read/written by bare name inside the interface's own static members or by qualified `IName.Field` (`IBox[int32].Field` for a generic interface), and compound assignment (`+=` / `-=`) is supported. On a generic interface each closed construction owns independent static storage (access sites reference the field through a `TypeSpec` for the construction, so `IBox[int32]` and `IBox[string]` are distinct), matching CLR per-construction static-field semantics. An `event` member inside the interface `shared` block remains unsupported and is rejected with GS0330. Implementers supply the static via their own `shared { … }` block; generic methods constrained by the interface can dispatch through `T.M(...)`, which the compiler lowers to the CLR's `constrained. !!T  call <iface>::<method>` pattern. Per ADR-0090 (issue #756) an interface may also declare **private helper methods** — instance helpers as `private func` directly inside the interface body, or static private helpers as `private func` inside the interface's `shared { … }` block — that participate in the interface's own implementation but are NOT part of the public contract. A sibling default method on the same interface can call the helper; implementers cannot see it and cannot override it. The helper MUST carry a body and is emitted as `MethodAttributes.Private | HideBySig` (plus `Static` when declared inside the `shared { … }` block). Classes can implement interfaces and values can upcast to implemented interfaces. An interface MAY itself **extend one or more base interfaces** via a `: A, B` clause directly after the interface name (issue #1006), mirroring C# `interface B : A`. Each entry in the clause MUST resolve to an interface — a G# interface or an imported CLR interface; naming a class or struct base is rejected with **GS0391**. A derived interface inherits the members of every base interface (an `interface B : A` surfaces `A`'s members on `B`, so a `B`-typed reference may call inherited members and dispatch reaches the implementer), records each base interface in metadata as an `InterfaceImpl` row on its TypeDef, and a class or struct implementing the derived interface must satisfy both the inherited and the directly declared members (the implementer's interface set is expanded to the transitive closure, matching C#). `sealed interface` declares a Kotlin-style closed hierarchy. When two unrelated interfaces both supply a default body for the same signature, the implementing class must declare its own override (GS0318); inside that override (or any other instance member) the class may delegate to one of the inherited defaults via **explicit-base interface call** syntax `base[IFoo].M(args)` (ADR-0091 / issue #757). The base-call emits as a non-virtual `call instance R IFoo::M(...)` so the inherited body runs without re-dispatching through the v-table; private interface helpers (ADR-0090) remain unreachable by design. The diagnostics for static-virtual members are GS0330–GS0333 (with GS0396 for a default-bodied static interface property and GS0397 for an implementer that omits a required static-virtual interface property); the diagnostics for private interface helpers are GS0334–GS0337; the diagnostics for explicit-base calls are GS0338–GS0341 (see the diagnostics reference). The `open`, `override`, and `sealed override` modifiers on interface methods remain deferred follow-ups (GS0321).

### Enums

Enums are declared with `enum Name { ... }`. They may not be generic and must contain at least one member. Equality is supported, and switch exhaustiveness diagnostics understand enum members.

An enum whose members carry payload parameters is a **discriminated union** (ADR-0078 §5 / issue #725):

```gsharp
enum Shape {
    Circle(r float64);
    Square(s float64);
    Empty
}
```

The parser desugars each payload-bearing case into a class deriving from a sealed base named after the enum, so construction (`Circle(2.0)`), pattern matching (`case c is Circle:`), and exhaustiveness checking reuse the sealed-class machinery.

### Generics

Generic declarations and instantiations use brackets rather than angle brackets. Type parameters can have variance markers `in` and `out` and zero or more constraints inside the same bracket section: the legacy single-identifier slot accepts `any`, `comparable`, or an **interface name** — a G# interface or an imported CLR interface, non-generic (e.g. `[T IDisposable]`) or constructed-generic, including the self-referential form `[T IComparable[T]]` where the type parameter appears in its own constraint (ADR-0089 introduced the constructed shape `[T IAdd[T]]` for static-virtual sealed interfaces; issue #943 generalises it to any interface, including imported CLR generic interfaces such as `IComparable[T]` / `IEnumerable[T]`, so C#'s `where T : IComparable<T>` migrates faithfully; issue #1052 removes the remaining restriction that a *user-declared* G# interface had to be `sealed`, so **any** user interface — sealed or not, generic or not, including the self-referential `[T IFace[T]]` form — is a legal constraint). The same legacy slot also accepts a **base class** as a constraint, mirroring C#'s `where T : BaseClass` (issue #1056): a user-declared class — open or sealed, generic or not, including the CRTP-style self-referential `[T Box]` / `[T Box[T]]` forms where the class names itself in its own constraint — or an imported reference-type class. C# permits at most one base-class constraint; G#'s single legacy slot enforces this structurally. A *value type* (a non-class struct or an enum) is still rejected with **GS0153**. Inside the body of a function so constrained, the instance members of the constraint interface are available on values of `T` (e.g. `a.CompareTo(b)` binds because `T : IComparable[T]`); the call is emitted as the verifiable CLR `constrained. !!T  callvirt <iface>::M(...)` sequence and a matching `GenericParamConstraint` metadata row is written so the produced assembly verifies. The instance members of a base-class constraint bind the same way (e.g. `x.Speak()` binds because `T : Animal`), emitted as `constrained. !!T  callvirt <class>::M(...)` over the class's own method so virtual dispatch resolves the most-derived override at runtime, again with a `GenericParamConstraint` row pointing at the class. A type argument that does not implement the constraint interface — or, for a base-class constraint, does not equal or derive from the constraint class — is rejected with **GS0152**. ADR-0097 (#775) adds three repeatable flag-style constraints — `class`, `struct`, and `new()` — that may appear in any order after the legacy slot. The flag constraints map directly to the matching CLR `GenericParameterAttributes` bits (`ReferenceTypeConstraint`, `NotNullableValueTypeConstraint` + the implied `DefaultConstructorConstraint`, and `DefaultConstructorConstraint` respectively). Mutually exclusive combinations (`class struct`, `struct new()`) are rejected as **GS0361**. A type parameter that carries a `new()` constraint may be **constructed** inside the generic body with the call-like spelling `T()` (issue #988): the construction lowers to a reified `System.Activator.CreateInstance<T>()` (the standard C# `new()`-constraint lowering, ADR-0087), which produces a real instance for both reference types with a public parameterless constructor and value types. Constructing a type parameter that lacks a `new()` constraint is rejected with **GS0389** (mirrors C# CS0304); a type **argument** that cannot satisfy a `new()` constraint at the instantiation site is rejected with **GS0152**. Construction works for both generic types (`class Factory[T new()]`) and generic functions (`func make[T new()]()`).

```gsharp
func Identity[T any](value T) T {
    return value
}

func Map[T class, U class](self T?, f (T) -> U) U?         { /* class-typed Optional.Map */ }
func Map[T struct, U struct](self T?, f (T) -> U) U?       { /* struct-typed Optional.Map */ }
func Make[T class new()]() T { return T() }                 // class + new(): T() constructs T (issue #988)

let x = Identity[int32](42)
```

The implementation emits **reified CLR generic metadata** for user-declared and imported generic types and methods: `TypeDef` carries `GenericParam` rows, signatures over `T` encode `Var(idx)`/`MVar(idx)`, closed CLR generics that mention an in-scope type parameter (`List[T]`) emit as honest `GenericInstantiation` blobs, and open-bearing delegate shapes (`func(T) U`) dispatch through reified `Func`N` MemberRefs on constructed `TypeSpec`. The full audit, target metadata, and the R1–R7 staging that delivered this state are recorded in ADR-0087. Generic method inference is implemented for supported cases.

### Type syntax

```ebnf
TypeClause = identifier TypeArgList? "?"?
           | "[" number? "]" identifier TypeArgList? "?"?
           | "[" number? "]" TypeClause "?"?
           | "(" TypeClause { "," TypeClause } ")" "?"?
           | "(" TypeClauseList? ")" "->" TypeClause "?"?
           | "async" "(" TypeClauseList? ")" "->" TypeClause "?"?
           | "map" "[" TypeClause "]" TypeClause "?"?
           | "chan" TypeClause "?"?
           | "sequence" "[" TypeClause "]" "?"?
           | "async" "sequence" "[" TypeClause "]" "?"?
           | "func" "(" TypeClauseList? ")" TypeClause? "?"?                  (* deprecated, GS0303 *)
           | "async" "func" "(" TypeClauseList? ")" TypeClause? "?"?          (* deprecated, GS0303 *)
           | "*" TypeClause "?"? .
TypeClauseList = TypeClause { "," TypeClause } .
TypeArgList = "[" TypeClause { "," TypeClause } "]" .
```

The function-type productions disambiguate against the tuple-type production by bounded look-ahead: in a type-clause slot, an opening `(` is a function-type clause iff the matching `)` is followed by `->`, otherwise it is a tuple-type clause. The arrow form is the canonical spelling per [ADR-0075](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0075-arrow-function-type-clause.md); the legacy `func(T) R` and `async func(T) R` shapes still parse for one release and emit `GS0303`.

Byref/pointer syntax exists as `*T`, unary `&`, and unary `*`. It is primarily an emit/interop feature today; the evaluator rejects the generic address-of and dereference path.

The prefix `*T` is **context-sensitive** (ADR-0122 / issue #1014). **Outside** an `unsafe` context it denotes a *managed* by-ref pointer (CLR `ELEMENT_TYPE_BYREF`, `T&`): GC-tracked, legal only as a ref-kind parameter (`ref`/`out`/`in`), a `ref` return, or a `let ref` local — and rejected as a field type (`GS9006`) or plain parameter type (`GS0243`). **Inside** an `unsafe` context the same `*T` denotes an *unmanaged* raw pointer (CLR `ELEMENT_TYPE_PTR`, C# `T*`): not GC-tracked, and legal as a field, local, and plain (non-ref-kind) parameter type. An `unsafe` context is entered by an `unsafe` modifier on a function (`unsafe func F(...)`), an `unsafe { … }` block statement, or an `unsafe` modifier on a type declaration (`unsafe class` / `unsafe struct`); `unsafe` is a contextual keyword (no new reserved word). The `unsafe` modifier on a function binds both its body and its **signature** (parameter + return types) in an unsafe context — this holds for a free function, an extern, and (issue #1036) a *method* declared inside an otherwise-*safe* `class`/`struct` (instance, static/`shared`, or interface member), so a single unsafe method may take/return unmanaged pointers without marking the whole type `unsafe`. A non-`unsafe` method's `*T` keeps its managed by-ref meaning (`GS0243`). The legal pointee subset is the blittable primitives (`int8`…`int64`, `uint8`…`uint64`, `nint`/`nuint`, `float32`/`float64`, `bool`, `char`), pointers-to-pointers, and blittable user/value structs `*S` (issue #1034 — `S` must be a value type whose fields are all blittable, mirroring C#'s "unmanaged type" rule); the opaque byte pointer (C# `byte*`) is spelled `*uint8`, while a true void-element pointer (C# `void*`) is spelled `*void` — a `ELEMENT_TYPE_PTR` over `ELEMENT_TYPE_VOID` that carries no element type (ADR-0122 §3 / issue #1033). A pointer to a managed reference type, a non-blittable struct (one with a string/class/other managed field), or a formatted class is rejected with `GS0398`. Inside an unsafe context the unmanaged pointer supports dereference read/write (`*p`), indexing (`p[i]` ≡ `*(p + i)`), scaled arithmetic (`p + i` / `p - i`), pointer difference (`p - q` for two operands of the same `*T`, yielding the scaled element count `((nint)p - (nint)q) / sizeof(T)` as `nint`; mismatched `*T - *U` remains an error — issue #1032), comparison/equality, a null pointer (`nil`), casts between pointer types and to/from `nint`/`IntPtr` (the `(byte*)x` ≡ `*uint8(x)`, `(void*)x` ≡ `*void(x)`, and `(nint)p` round-trip), and use as a plain `@DllImport`/`@LibraryImport` parameter. For a blittable struct pointer `*S` (issue #1034) the deref/index load and store emit `ldobj`/`stobj <S>`, the arithmetic/difference scale is the CIL `sizeof S` opcode (a user struct's size is not known at G# compile time), and the value is member-accessible through the pointer in both the explicit `(*p).field` form and the arrow sugar **`p->field`** (read and write, plus `p->method(...)`). `p->member` is parsed as sugar for `(*p).member` (no new bound-node kinds); it reuses the existing `->` token, and because a bare `p -> body` is also a single-identifier lambda, `p->member` is disambiguated to pointer member access only inside an unsafe context (a single-identifier lambda inside unsafe code is still written `(x) -> body`). A blittable struct pointer round-trips through `nint` and casts to/from a typed pointer via the `*S(expr)` form (the struct analogue of `*uint8(p)`). Most of these operations are lowered in the binder to native-int arithmetic and reinterpret conversions; the only new lowered node is `sizeof S` (issue #1034). Genuinely-unsafe pointer IL is *unverifiable by design* (as in C#); the emit tests assert runtime behaviour. A `*void` value cannot be directly dereferenced, indexed, or advanced by arithmetic (it has no element type); those operations are rejected with `GS0403` until it is cast to a typed pointer `*T`, but comparison/equality and `nint`/typed-pointer casts are allowed. **Managed function pointers** are spelled `*func(T1, T2) R` (ADR-0122 §9 / issue #1035): only legal inside `unsafe` (`GS0404`), obtained from a static/free method with `&Method` (emits `ldftn`; `GS0405` on instance/overloaded/generic methods), invoked directly with `fp(args)` (emits `calli`), and round-trippable through `nint`. **Fixed-size buffers** are spelled `fixed name [N]T` inside an `unsafe struct` (ADR-0122 §10 / issue #1035): the buffer lowers to a compiler-generated nested `<name>e__FixedBuffer` struct (explicit `ClassLayout` size `N * sizeof(T)`, single `FixedElementField`, `[CompilerGenerated]`/`[UnsafeValueType]`) and the containing field carries `[FixedBuffer(typeof(T), N)]`; a reference to the buffer decays to a `*T` to the first element, indexable as `name[i]`. The element type must be a blittable primitive (`GS0409`) and `N` a positive constant (`GS0408`). `fixed`/pinning is implemented separately (ADR-0125 / issue #1026, described below).

`stackalloc [n]T` stack-allocates a contiguous buffer of `n` elements of a blittable element type `T`, emitted as the CIL `localloc` instruction and reclaimed when the method returns (ADR-0124 / issues #1024, #1057, #1041). It uses **G#-style array grammar** — the bracketed count first, then the element type (`stackalloc [4]uint8`), mirroring G#'s array/slice type grammar (`[]T`, `[n]T`). It has two forms, selected by the target type exactly as the unsafe gating of `*T` falls out of context. The **safe** form is the default and needs **no** `unsafe` context: `var buf = stackalloc [4]uint8` yields a `System.Span[T]` (or `System.ReadOnlySpan[T]` when the target is one) over the allocated block, so element access is bounds-checked and `.Length` is available. The **unsafe** form is reached only inside an `unsafe` context when the target type is a `*T` unmanaged pointer (`var p *int32 = stackalloc [3]int32`), yielding the raw `localloc` pointer; outside an unsafe context no pointer target exists, so the safe `Span[T]` form is always chosen and no extra "unsafe required" diagnostic is needed. The count is a full expression (a runtime length is allowed). An optional brace-delimited **initializer** supplies the element values: `stackalloc [3]int32{1, 2, 3}` (explicit count) or the count-inferred `stackalloc []int32{1, 2, 3}` (empty brackets — the length comes from the initializer). Each initializer element must be convertible to `T`, and the values are stored into the block through the `localloc` pointer via scaled indirect writes (for both the safe `Span[T]` and unsafe `*T` forms). A count-inferred `stackalloc []T` with no initializer is rejected with `GS0411`, and an explicit `stackalloc [n]T{…}` whose constant count disagrees with the initializer length is rejected with `GS0412` (matching C#). The element type must be a blittable primitive or a pointer; a managed/non-blittable element type is rejected with `GS0399`. Without an initializer the buffer is **zero-initialised** (method bodies are emitted with `.locals init`, which zeroes `localloc` memory, matching C# safe-`stackalloc`). `stackalloc` is a contextual keyword recognised only in the `stackalloc […` shape, so it remains usable as an ordinary identifier elsewhere. `localloc` IL is *unverifiable by design* (as in C#); the emit tests assert runtime behaviour.

The `fixed` statement `fixed <name> *T = <source> { … }` pins a managed buffer for the duration of its body block and binds an unmanaged pointer `<name>` of type `*T` to the buffer's first element (ADR-0125 / issue #1026) — the G# spelling of C# `fixed (T* p = source) { … }`. The header is paren-less, consistent with G#'s other statement headers (`if`/`for`/`while`/`unsafe`), and `fixed` is a **contextual keyword** recognised only in the `fixed <ident> *…` shape, so it remains usable as an ordinary identifier elsewhere; the source expression is parsed with struct-literal suppression so the `{` that follows opens the body block rather than a composite literal. Because it produces a raw unmanaged pointer, the statement is legal **only inside an `unsafe` context** (function, `unsafe { … }` block, or unsafe type); used outside one it is rejected with `GS0400`. The **source** must be a pinnable managed buffer: a slice/array `[]T` (the cs2gs mapping of a C# `T[]`, CLR-backed by `T[]`) or a `string`. The pointer's pointee type must match the buffer's element type (`uint16`/`char` are accepted interchangeably for `string`); any other source — or a pointee mismatch — is rejected with `GS0401`. The bound `*T` pointer is in scope **only inside the body** and is read-only. Lowering mirrors the C# compiler: a synthetic CLR **pinned local** (`.locals init ([n] T[] pinned)` for a slice/array, `string pinned` for a `string`) holds the buffer reference so the GC cannot move it; the pointer is derived as the element-0 address (`ldelema` with a null/zero-length guard for arrays — an empty buffer yields a null pointer — and `RuntimeHelpers.OffsetToStringData` for strings); on block exit the pinned local is released (`ldnull; stloc`). Pinning + unmanaged-pointer dereference IL is *unverifiable by design* (as in C#); the emit tests assert runtime behaviour. Pinning a span-like source via `GetPinnableReference` is a deferred follow-up.

CLR `ref struct` types such as `Span[T]` and `ReadOnlySpan[T]` are consumable as stack-only values (ADR-0056): they are indexable (`s[i]`), ref-returning members auto-dereference in rvalue position, a `[]T` slice converts implicitly to a span, and a user `ref struct X { … }` may embed a closed generic value-type field. Stack-escape violations are reported as `GS0219`; writing through a `ReadOnlySpan[T]` element is `GS0226`. The full ref-safe-to-escape analysis is deferred (issue #376).

## Declarations and scope

### Packages and imports

A package declaration names the package for the compilation unit. Imports bring packages, CLR namespaces, or aliases into scope. The compiler can add an implicit `System` import by default; `/noimplicitimports` disables it.

```ebnf
CompilationUnit = PackageDecl? ImportDecl* Member* EOF .
PackageDecl     = "package" identifier { "." identifier } .
ImportDecl      = "import" ( identifier "=" )? identifier { "." identifier } .
```

### Top-level declarations

Top-level members are functions, type declarations, variable declarations, or top-level statements. Mixing explicit `Main` and top-level statements is diagnosed. Accessibility modifiers are `public`, `internal`, `protected`, and `private`; defaults depend on declaration context. The `protected` modifier is only valid on members of an inheritable `open class` (see *Protected accessibility* below); applying it to a top-level declaration, a non-`open` (sealed) class, or a struct member is rejected with GS0380.

```ebnf
Member        = Annotation* Accessibility? ( Async? FunctionDecl | TypeDecl | VariableDecl | GlobalStatement ) .
Accessibility = "public" | "internal" | "protected" | "private" .
Annotation   = "@" ( AnnotationTarget ":" )? identifier { "." identifier } ( "(" Arguments? ")" )? .
```

### Functions and methods

Functions use `func`. Receiver clauses declare extension functions on types this package does not own (BCL primitives, imported CLR types, types from referenced packages); methods on owned classes **and owned structs** (issue #938) are declared inside the type body. Per [ADR-0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md), a receiver-clause method whose receiver type is owned by the current package emits the soft `GS0314` warning (for both owned classes and owned structs), steering authors to the in-body site. Operator overloads use `operator` followed by the operator token and map to CLR operator names downstream (operators continue to use the receiver-clause form and are exempt from `GS0314`). Parameters may carry a ref-kind modifier (`ref`, `out`, or `in`, ADR-0060) and may declare a compile-time-constant default value to become optional (ADR-0063). User functions may be overloaded as long as overloads differ by parameter types, arity, or ref-kinds; two declarations that differ only in return type are rejected as `GS0264`. One narrow exception (issue #985, the *covariant-return interface bridge*) admits two same-name, same-parameter methods that differ only by return type **when each one satisfies a distinct interface slot** — most commonly a generic collection that implements `IEnumerable[T]` by declaring both the generic `func GetEnumerator() IEnumerator[T]` (satisfying `IEnumerable[T]`) and a non-generic `func GetEnumerator() IEnumerator` (satisfying the inherited `System.Collections.IEnumerable`). Because G# has no explicit-interface-implementation syntax, the non-generic method is emitted with an explicit `MethodImpl` row binding it to `IEnumerable.GetEnumerator`. The inherited base-interface slot is required: omitting the non-generic bridge leaves `IEnumerable.GetEnumerator` unimplemented and is reported as `GS0187`.

**User-defined conversion operators (issue #1017).** A package may declare implicit and explicit conversions on its own struct types using the spelling `func operator implicit (x T) U { … }` and `func operator explicit (x T) U { … }`. The contextual keywords `implicit` and `explicit` are recognized **only** immediately after `operator` (neither is a reserved keyword elsewhere). A conversion operator is implicitly **static**, takes **exactly one** by-value parameter (the source operand type `T`) and declares the target type `U` as its return type; it uses no receiver clause. At least one of `T` or `U` must be a struct owned by the current package, and `T` and `U` must differ. The declaration is emitted as a CLR `public static hidebysig specialname` method named `op_Implicit` or `op_Explicit` with signature `U (T)`, matching C#. Implicit conversions are applied automatically at assignment, at argument passing, and wherever a target type is expected; explicit conversions are applied at the type-call cast form `U(x)`. When a user conversion is applied the compiler emits a `call` to the operator. Conversions defined on imported/referenced CLR types (BCL `op_Implicit`/`op_Explicit`) are likewise recognized and applied. Malformed declarations are diagnosed: more or fewer than one parameter is `GS0393`; neither the source nor the target being an owned struct (or `T` equal to `U`) is `GS0394`; declaring two conversions with the same source/target pair (whether implicit or explicit) is `GS0395`.

```ebnf
FunctionDecl      = "func" ReceiverClause? ( identifier | OperatorName | ConversionOperatorName ) TypeParamList? "(" Parameters? ")" RefReturnClause? FunctionBody .
AsyncFunctionDecl = "async" FunctionDecl .
FunctionBody      = Block | ";" .
ReceiverClause    = "(" Parameter ")" .
OperatorName      = "operator" OperatorToken .
ConversionOperatorName = "operator" ( "implicit" | "explicit" ) .
TypeParamList     = "[" TypeParameter { "," TypeParameter } "]" .
TypeParameter     = ( "in" | "out" )? identifier ConstraintName? .
Parameters        = Parameter { "," Parameter } .
Parameter         = Annotation* ParameterModifier? identifier "..."? TypeClause ( "=" ConstantExpression )? .
ParameterModifier = "ref" | "out" | "in" | "scoped" .
RefReturnClause   = "ref"? TypeClause .
```

A function declared `func f(...) ref T` returns a managed pointer and pairs with the `return ref <lvalue>` statement form (diagnostics `GS0248`–`GS0255`). The `scoped` modifier on a `ref struct` / managed-pointer parameter constrains the value from escaping the call (enforced by the by-ref-like rules in `GS9004` / `GS9006`).

A function declared `func f(name ...T)` is **variadic**: the source-level element type is `T`, the parameter is seen inside the body as a slice `[]T`, and the call site may supply either *N* trailing positional arguments (packed into a freshly allocated `[]T`) or exactly one trailing `[]T` value (forwarded unwrapped — array identity is preserved). At most one variadic parameter is allowed per signature (`GS0364`) and it must be the last parameter (`GS0145`). Variadic declarations are accepted on top-level `func`, class instance / static methods, interface methods (including default-body methods), constructors, lambdas (function-literal and arrow form), named delegate declarations (ADR-0102), and primary-constructor parameter lists on `class` / `struct` / `data class` / `data struct` / `inline struct` (ADR-0103). On a primary-constructor parameter list the trailing variadic promotes to a `[]T` auto-field with the same name, exactly as the explicit `init(…)` lowering would. The emitter stamps `[System.ParamArrayAttribute]` on the last parameter so the method is consumable by C# / F# / VB callers using their native variadic syntax. The C# `params` keyword is not recognised in G# source; encountering it reports `GS0363` pointing at the canonical `...T` form. See [ADR-0101](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0101-variadic-params.md), [ADR-0102](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0102-variadic-params-additional-sites.md), and [ADR-0103](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0103-primary-ctor-variadic.md).

A `;` in place of the `Block` body marks the declaration as "no managed body". Per ADR-0086, the body-less form is reserved for functions annotated with `@DllImport("libname", ...)` — see [Native interop (P/Invoke)](#native-interop-pinvoke). An unannotated `;` body is rejected with `GS0325`.

#### Overload resolution and generic constraints

The binder picks a callee in three steps: (1) collect every name- and arity-compatible candidate (instance methods, extension methods with a matching receiver type, and free functions); (2) filter to the **applicable** subset whose parameter types accept the supplied arguments after standard conversions; (3) rank the applicable set and pick the unique most-specific candidate, otherwise report `GS0160` (ambiguous overload).

For generic candidates the filter step additionally validates the inferred (or explicitly supplied) type arguments against each generic parameter's CLR constraints — `where T : class`, `where T : struct`, `where T : new()`, and base / interface bounds. A candidate whose constraints are violated by the inferred type arguments is dropped before ranking. Constraints are checked **after** type inference: the type arguments inference picked are what the check sees. (See ADR-0088.)

When multiple candidates survive parameter-shape ranking, the binder applies a final tie-break that prefers the candidate with the more specific generic-parameter constraints. The per-parameter ordering is `where T : struct` > `where T : class` > (no constraint); a candidate dominates another iff every type-parameter slot's score is greater-or-equal and at least one is strictly greater. Mutually-incomparable candidates remain ambiguous and report `GS0160`.

This rule lets `Gsharp.Extensions.Optional.Map` carry two overloads — `where T : class` and `where T : struct` — under one name, with the binder picking the right one based on the receiver type.

### Type declarations

```ebnf
TypeDecl          = TypeAliasDecl | DelegateAliasDecl | AggregateDecl .
TypeAliasDecl     = "type" identifier TypeParamList? "=" identifier .
DelegateAliasDecl = "type" identifier TypeParamList? "=" "delegate" "func" "(" Parameters? ")" TypeClause? .
AggregateDecl     = Visibility? OpenOrSealed? Data? Inline? AggregateKeyword identifier TypeParamList? PrimaryCtor? BaseClause? AggregateBody? .
AggregateKeyword  = "class" | "struct" | "enum" | "interface" .
Visibility        = "public" | "internal" | "private" .  (* type-level; "protected" is a member-only modifier *)
OpenOrSealed      = "open" | "sealed" .
PrimaryCtor       = "(" Parameters? ")" .
BaseClause        = ":" QualifiedTypeName ( "(" Arguments? ")" )? { "," QualifiedTypeName } .
AggregateBody     = "{" Member* "}" .
```

The aggregate keyword IS the declaration keyword (ADR-0078). Legal modifier combinations are enumerated in ADR-0078 §3 — every other combination is rejected at parse time (diagnostics GS0306–GS0312). Discriminated-union enums (members that carry a payload parameter list) are desugared at parse time to a sealed base class plus one subclass per case (ADR-0078 §5 / issue #725). The `type` keyword is retained only for the alias and named-delegate forms above.

```ebnf

A `DelegateAliasTail` declares a real CLR `MulticastDelegate`-derived named delegate type (ADR-0059), so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types. Diagnostics `GS0233`–`GS0234` cover malformed declarations.

### Members

```ebnf
StructBody       = "{" StructMember* "}" .
StructMember     = Annotation* Accessibility? ( OpenOrOverride* ( MethodDecl | PropertyDecl | EventDecl | ConstructorDecl ) | SharedBlock | FieldDecl ) .
OpenOrOverride   = "open" | "override" .
ConstructorDecl  = "init" "(" Parameters? ")" ( ":" identifier "(" Arguments? ")" )? Block .
SharedBlock      = "shared" "{" SharedMember* "}" .
SharedMember     = Accessibility? ( MethodDecl | PropertyDecl | EventDecl | FieldDecl ) .
FieldDecl        = Accessibility? ( "var" | "let" ) identifier TypeClause ( "=" Expression )? .
PropertyDecl     = "prop" ( identifier | IndexerHeader ) TypeClause PropertyBody? .
IndexerHeader    = "this" "[" Parameters "]" .  (* ADR-0118: user indexer member, emitted as the CLR default `Item` property *)
PropertyAccessor = ( "get" | ( "set" | "init" ) ( "(" identifier ")" )? ) ( Block | ";" )? .
EventDecl        = "event" identifier TypeClause EventBody? .
EventAccessor    = ( "add" | "remove" | "raise" ) ( Block | ";" )? .
InterfaceBody    = "{" ( InterfaceMethodDecl | PropertyDecl | EventDecl )* "}" .
InterfaceMethodDecl = "func" identifier "(" Parameters? ")" TypeClause? FunctionBody .  (* FunctionBody ";" = no-body (abstract) marker; issue #881 *)
```

#### Protected accessibility (issue #950)

The `protected` modifier (CIL `family`) makes a member accessible **within its
declaring type and within the bodies of types that derive from it**, and
inaccessible from unrelated external code. It mirrors C# `protected`:

- A `protected` field, method, property (and its `get`/`set`/`init` accessors),
  event, or constructor is visible to the declaring class and to any class that
  derives — directly or transitively — from it, when accessed from the derived
  class's own body. Access from outside that inheritance chain reports
  **GS0379** (`'<member>' is inaccessible due to its protection level`).
- Because protection is only meaningful where a derived type can exist,
  `protected` is permitted **only on members of an `open class`** (the only
  inheritable G# types). Applying it to a member of a non-`open`/sealed class, a
  `struct` member (structs are CLR value types and are never inheritable), a
  nested type whose container is not an `open class`, or a top-level
  declaration is rejected with **GS0380**
  (`'protected' is only valid on members of an inheritable 'open' class`).
- `protected` composes with `open`/`override`: a `protected open func` may be
  overridden by a `protected override func` in a derived `open class`, and the
  call dispatches virtually.
- Emit: `protected` maps to `MethodAttributes.Family` / `FieldAttributes.Family`
  (and `TypeAttributes.NestedFamily` for an eligible nested type), so the CLR
  enforces the same rule on consumers compiled separately and the metadata is
  IL-verifiable.

Unlike `private`/`internal` — which G# currently leaves to CLR enforcement at
run time — `protected` is enforced both at bind time (GS0379) and by the emitted
`family` metadata.


#### Indexer members (ADR-0118)

A type can declare a **user indexer member** with the `prop this[...]` form,
giving it an element-access syntax (`obj[i]`, `obj[i] = v`):

```gsharp
class Repo[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    prop this[index int32] T {        // get-only indexer
        get { return _items[index] }
    }
}
```

An indexer is an instance member with a non-empty index parameter list and at
least one accessor body. It is emitted as the CLR default indexer: an `Item`
property whose accessors are `get_Item` / `set_Item`, with a
`System.Reflection.DefaultMemberAttribute("Item")` on the declaring type, so
the indexer round-trips with C# and other CLR consumers. The enclosing type may
be generic; index parameter and element types are substituted through the
receiver's type arguments. An indexer declared without index parameters reports
`GS0370`; one declared without an accessor body (an "auto-indexer") reports
`GS0371`. Element **access** (`obj[i]`) currently binds single-parameter
indexers; multi-parameter and overloaded indexers are reserved for a future
revision.

A property declared on a **generic** type whose type mentions a class type
parameter (`prop Value T`, or a constructed form such as `prop Items []T`) is
substituted through the receiver's type arguments on member access, exactly like
a generic field: reading or writing `box.Value` where `box : Box[int32]` binds
as `int32` (issue #989). The accessor call on a constructed receiver is emitted
against the constructed type so the substitution holds at run time.

#### Init-only accessors (issue #946)

A property may declare an **`init` accessor** in place of `set`, in either the
auto-property (`prop Name string { get; init; }`) or explicit-body
(`init { backingField = value }`) form. An `init` accessor behaves like a `set`
accessor — it writes the property — except that it may only be invoked while the
object is being initialized:

* inside a constructor of the declaring type,
* in an object/aggregate initializer at the creation site (`T() { Prop = v }`),
* or from another `init` accessor of the same instance.

Assigning to an init-only property anywhere else (after construction completes)
is a compile error, `GS0372`. Reading an init-only property is always allowed.
A property may not declare both `set` and `init` (`GS0373`), and an `init`
accessor may not appear on a `shared` (static) property (`GS0374`).

An `init` accessor is emitted as a `set_Prop` method whose `void` return carries
the `System.Runtime.CompilerServices.IsExternalInit` required-custom-modifier
(modreq), exactly as C# encodes init-only setters, so the accessor round-trips
with C# and other CLR consumers. An auto-property `init;` emits a writable
backing field plus the init-only setter.

#### Read-only (`let`) fields (issue #947)

A field declared with `let` is **read-only**, mirroring a C# `readonly` field. A
`let` field is assignable only **during construction**:

* by its declaration initializer (`let x int32 = 5`), and/or
* inside the declaring type's constructor(s) (`init(...)`), targeting the
  instance being constructed (the bare `x = …` form, or the qualified
  `this.x = …` form). As in C#, the constructor may write the field any number
  of times; a `let` field with no initializer may instead be assigned once in
  the constructor.

Assigning a `let` field anywhere else — from a non-constructor method, after
construction completes, on another instance (`other.x = …`), or from a derived
type's constructor against a base-declared `let` field — is a compile error,
`GS0127`. Reading a `let` field is always allowed. A `let` field that is never
assigned keeps its type's zero/default value, exactly like an unassigned C#
`readonly` field. A `var` field has no such restriction and remains mutable.

A `let` field is emitted with the CLR `initonly` field flag — the metadata
encoding of a C# `readonly` field — so the read-only guarantee holds at the
metadata level and constructor writes remain verifiable IL. Static `let` fields
keep their existing behavior: they are assignable only through their declaration
initializer (materialized into the synthesized static constructor), since G#
exposes no user-authored static constructor body.

#### Inline field initializers (issue #948)

Any `const`, `let`, or `var` field in a type body may carry an inline
initializer with the `= expr` suffix:

```gsharp
class Foo {
  const one string = "value"
  let two string = "something"
  var three string = "this should work"
}
```

The semantics match C#:

* An **instance** field initializer (`let`/`var x T = expr`) runs as part of
  **every** instance constructor, **before** the constructor body, in textual
  declaration order. This holds for a primary constructor, each explicit
  `init(...)` constructor, and the synthesized default constructor when no
  constructor is declared. Because the initializer runs before the constructor
  body, it may not reference `this`, another instance member of the same object,
  or a constructor parameter; doing so reports `GS0377` (assign such fields in an
  `init(...)` body instead). A `var` field initialized inline may still be
  overwritten by a later `init(...)` body.
* A `let` field initializer counts as a construction-time write, so it composes
  with the `initonly` emission described above (the field remains read-only).
* A **static** field initializer (a `let`/`var` inside a `shared { ... }` block)
  runs in the static constructor (`.cctor`) in declaration order.
* A **`const`** field is a **compile-time constant**: it is implicitly static and
  read-only, its initializer must fold to a constant expression, and it is
  emitted as a CLR literal field (a `Constant` metadata row) usable in constant
  contexts and from other assemblies. A `const` field with no initializer reports
  `GS0375`; a `const` field whose initializer is not a constant expression reports
  `GS0376`.
* For **value types** (`struct` / `data struct`), which have no class-style
  constructor that could run inline initializers, a composite struct literal
  (`Pt{ ... }`) zero-initializes the storage and then applies each declared field
  initializer for any field the literal omitted, in declaration order.

## Expressions

### Precedence

Unary operators bind tighter than binary operators. Binary operators are left-associative; higher precedence binds tighter.

| Precedence | Operators | Meaning |
| --- | --- | --- |
| 8 | `+`, `-`, `!`, `^`, `*`, `&`, `<-`, `await` | unary |
| 7 | `*`, `/`, `%`, `<<`, `>>`, `&`, `&^` | multiplicative, shifts, bitwise and, bit clear |
| 6 | `+`, `-`, `\|`, `^` | additive, bitwise or, xor |
| 5 | `==`, `!=`, `<`, `<=`, `>`, `>=`, `is`, `as` | equality, comparison, type test, safe cast |
| 4 | `&&` | logical and |
| 3 | `\|\|` | logical or |
| 2 | `??` | null coalescing (right-associative) |
| 1 | `?` … `:` … | conditional (ternary, right-associative) |

The conditional expression `cond ? whenTrue : whenFalse` (ADR-0062) requires `cond` to be `bool` and the two branches to share a common type. Mismatched branches report `GS0263`. The narrow ADR-0061 form `ref cond ? lhs : rhs` (and its `out` / `in` siblings) survives as a payload to a ref-kind argument; diagnostics `GS0260`–`GS0262` apply there.

### Null-coalescing operator `??` (Issue #941)

The binary null-coalescing operator `a ?? b` evaluates `a`; if it is non-nil the result is `a`, otherwise `b` is evaluated and yields the result. The right operand `b` is evaluated **lazily** — only when `a` reads as nil. The left operand must be of a nullable type (a nullable reference type `T?` or a `Nullable<T>` value type); for a value-type `T?`, "is nil" is `HasValue == false`. The result type is the best common type of the operands: when both sides share an underlying type `T`, the result is `T` (when `b` is non-nullable) or `T?` (when `b` is itself nullable).

`??` is **right-associative** and sits at a precedence below `||` (logical or) and above the ternary conditional, so `a ?? b ?? c` parses as `a ?? (b ?? c)` and `a ?? b ? c : d` parses as `(a ?? b) ? c : d`. The compound form `a ??= b` (ADR-0072) is the assignment analogue. (G# previously spelled this operator `?:`; that spelling was removed in favor of `??` — see ADR-0116.)

The right operand may be a [throw-expression](#throw-expressions-issue-1018) — `a ?? throw e` (Issue #1018) — in which case the result type is `a`'s underlying type and the `throw` runs only when `a` reads as nil.

### Type-test and safe-cast operators

`expr is T` evaluates to `bool` — `true` when the runtime type of `expr` is assignable to `T`, `false` otherwise (including when `expr` is `nil`). `expr as T` performs a safe downcast: it returns the value typed as `T` when the cast succeeds, or `nil` when it fails. For reference types the result type is `T`; for value types, the target must be written as the nullable form `T?` (e.g. `x as int32?`) and the result type is `T?`. Using `as` with a non-nullable value type target produces diagnostic `GS0269`. Both operators use the CLR `isinst` instruction and sit at precedence level 4 (same as equality and comparison), so `x is String == true` and `a is T && b is U` parse as expected without extra parentheses. The existing pattern-level `identifier is Type` syntax inside `switch`/`case` arms is unaffected.

A successful `is` (or `!is`) test against a local, parameter, or read-only top-level `let` flow-narrows the receiver to the tested type for the rest of the enclosing flow region — see *Smart casts (flow narrowing)* below.

Postfix `!!`, member access `.`, null-conditional access `?.`, null-conditional indexing `?[`, indexing, calls, and generic instantiation are parsed greedily on primary expressions. This applies to **any** primary, including a parenthesized expression — for example `(a + b).GetType()`, `(nums)[0]`, and `("s").Length` are all valid. The sole exception is a bare numeric literal: `42.Member` is not accepted because it is ambiguous with float-literal lexing; wrap it as `(42).Member` instead (see ADR-0054).

### Primary expressions and calls

Primary expressions include literals, identifiers, calls, generic calls, struct literals, array or slice literals, map literals, function literals, switch expressions, if expressions (ADR-0064), tuple literals, `make(chan ...)`, `typeof(...)`, `nameof(...)`, and `default(...)` (ADR-0100). Calls accept positional, named, and ref-kind-prefixed arguments:

- **Named arguments** — `Foo(timeout: 30, retries: 3)` for free functions, user methods, user constructors, user extension functions, imported CLR methods and constructors, imported extension methods, and inherited CLR instance methods (including delegate `Invoke`). The canonical separator is `:`; the legacy `Foo(timeout = 30)` spelling is deprecated and emits the `GS0315` warning ([ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md), issue #720). Both spellings parse for one release; the `=` form is removed in a later release. Indirect calls through a function-typed or delegate-typed variable, and variadic call sites, do not accept named arguments because the call target does not preserve parameter names. Diagnostics `GS0244`–`GS0247` cover ordering, duplicates, and unknown names; `GS0315` covers the deprecated `=` separator.
- **Ref-kind arguments** — `f(ref x)`, `f(out var n)`, `f(in z)` (ADR-0060). The call-site modifier must match the parameter's declared kind (`GS0235`); `in` requires an explicit `in` at the call site to prevent silent spilling (`GS0242`).

Generic instantiation uses brackets and bounded lookahead to distinguish type arguments from indexing. Examples include `Id[int32](1)` and `Box[string]{Value: "x"}`.

Function literals use `func` or `async func`. A trailing lambda can appear after an explicit call close-paren and is desugared into the final argument. ADR-0074 (issue #714) also introduces a dedicated arrow-lambda expression form: `(p1, p2) -> body`. Parameter types and the return type are **inferred** from the target delegate type (ADR-0076, ADR-0119); they may also be spelled explicitly (`(p1 T1, p2 T2) -> body`). A single-parameter lambda may drop the parentheses (`x -> body`, issue #932). The body is either a single expression or a brace-delimited block expression whose trailing expression is the lambda value. Arrow lambdas share the function-literal capture, lowering, and emit pipeline (closures, `ldftn`/`newobj`, delegate construction). The inferred-type arrow lambda is the **canonical** lambda form (ADR-0119); the explicit `func (x T) R { … }` literal remains the alternative for when explicit typing is desired or no target type is available.

```ebnf
FunctionLiteral = "func" "(" Parameters? ")" TypeClause? Block
                | "async" "func" "(" Parameters? ")" TypeClause? Block .
TrailingLambda  = FunctionLiteral .
LambdaExpression = "(" Parameters? ")" "->" ( Expression | Block )
                | Identifier "->" ( Expression | Block ) .
```

### Accessor chains

Member access and indexing chain after primaries. `a.b`, `a?.b`, `a[i]`, `a?[i]`, `a.b(c)`, and generic call access forms are valid where the binder can resolve the target. Chains also apply to parenthesized and literal receivers — `(a + b).GetType()`, `(nums)[0]`, `("s").Length`, and `switch v { … }.ToString()` — with one exception: a bare numeric literal does not chain (`42.Member` is unsupported; write `(42).Member`). Assignment permits identifiers, indexed targets, field/property targets, and event `+=` or `-=` on accessors. Null-conditional forms (`?.`, `?[]`) are not allowed on the left-hand side of an assignment (see ADR-0073, diagnostic GS0301).

### Range and slice expressions (issue #1016)

A **range** uses the `..` operator inside an indexer to slice a contiguous portion of a sliceable value, mirroring C# range expressions. The lower and upper bounds are optional, giving four forms:

```gsharp
let xs = []int32{10, 20, 30, 40, 50}
let a = xs[1..3]   // elements 1,2 -> {20, 30}
let b = xs[..2]    // open lower bound -> {10, 20}
let c = xs[2..]    // open upper bound -> {30, 40, 50}
let d = xs[..]     // full copy -> {10, 20, 30, 40, 50}
```

The lower bound defaults to `0` and the upper bound defaults to the length of the target. Both bounds are `int32` offsets from the start; the result spans `[lower, upper)` (upper-exclusive), exactly like C#. The same `..` operator also forms a **standalone `System.Range` value** outside an index (issue #1038, below).

The binder resolves the target type to one of the following sliceable shapes and lowers the range to the corresponding BCL surface:

| Target | Lowering |
| --- | --- |
| Array `[N]T` / slice `[]T` | a fresh `[]T` allocated with the computed length and filled via `System.Array.Copy(src, start, dst, 0, length)` (a copy, not an alias) |
| `string` | `s.Substring(start, length)` |
| Span-like value (`int Length`/`int Count` + `Slice(int, int)`, e.g. `Span[T]`, `ReadOnlySpan[T]`, `Memory[T]`, `ArraySegment[T]`) | `value.Slice(start, length)` |
| A type exposing an indexer accepting `System.Range` | the `this[System.Range]` indexer is called directly with a constructed `System.Range` |

Slicing a target that matches none of these shapes reports `GS0392`.

#### From-end indices (`^n`, issue #1022)

A **from-end index** marker `^n` (mirroring C# `System.Index` with `fromEnd: true`) is recognized in the *leading position* of an index or range bound. It measures the offset `n` from the end of the target, i.e. the concrete offset is `length - n`:

```gsharp
let xs = []int32{10, 20, 30, 40, 50}
let last = xs[^1]    // last element -> 50
let nth  = xs[^2]    // second from end -> 40
let a = xs[1..^1]    // drop first and last -> {20, 30, 40}
let b = xs[..^3]     // all but last 3 -> {10, 20}
let c = xs[^2..]     // last 2 -> {40, 50}
let s = "abcdef"
let head = s[..^3]   // "abc"
```

A bare `a[^n]` reads the single element `length - n` from an array/slice, a `string`, or any value with an `int Length`/`int Count` property plus a `this[int]` or `this[System.Index]` indexer. Inside a range, a from-end bound computes `length - n` at lowering time for the array/string/span-like paths, and is passed through as `System.Index(n, fromEnd: true)` when the target exposes a `this[System.Range]` indexer.

The `^n` marker is only recognized at the *start* of an index/range bound. Elsewhere — including inside the offset expression itself (e.g. `a[^(x ^ y)]`) — `^` keeps its ordinary prefix one's-complement and infix bitwise-XOR meanings unchanged. For example, `a[i ^ j]` is an XOR-computed single index, and `^5` outside brackets is one's-complement.

#### Standalone range values (issue #1038)

The `..` operator also forms a **standalone `System.Range` value** outside an index, in the general expression grammar:

```gsharp
let r = 1..3       // r : System.Range
let s = a[r]       // index an array/slice/string/span by a Range value
let full = ..      // Range.All
let tail = 2..     // 2..end
let head = ..^1    // start..^1 (drop the last)
```

All four open forms (`lo..hi`, `lo..`, `..hi`, `..`) are supported. A bound becomes a `System.Index`: a plain value `v` is `Index(v)` (from-start), a `^n` marker is `Index(n, fromEnd: true)`, an open lower defaults to the start, and an open upper defaults to the end. The value is constructed as `new System.Range(start, end)`, matching how C# lowers a range expression, and is typed `System.Range`.

**Precedence.** The `..` operator binds *looser than every binary operator*, so each bound is a full expression: `1+2..3+4` parses as `(1+2)..(3+4)`. An open upper bound (`lo..`) ends at a closing delimiter, a separator, or a line break — so `let r = 1..` on its own line is the open range `1..end`, not a continuation onto the next statement.

**Indexing by a range value.** A `System.Range`-typed value used as an index argument (`a[r]`, or the inline `a[(1..3)]`) slices the receiver using the *same* shapes as the syntactic `a[1..3]` form: arrays/slices copy via `Array.Copy`, `string` uses `Substring`, span-like values use `Slice`, and a `this[System.Range]` indexer is called with the value directly. The concrete `start`/`length` are resolved from the range value at runtime via `System.Index.GetOffset(length)`.

**From-end restriction.** A from-end `^n` marker is allowed in the *upper* bound of a standalone range (`lo..^hi`, `..^hi`), where it is unambiguous because it follows `..`. A *leading* `^` at the very start of a standalone range is **not** allowed (`^a..b`), because it is genuinely ambiguous with the one's-complement unary operator (`^a` parses as `~a`); such a form reports `GS0410`. To slice from the end, index the value directly (`arr[^a..]`); to use a one's-complement value as a from-start lower bound, parenthesise it (`(^a)..b`).

### Composite literals

Struct literals use `TypeName{Field: value}`. Data structs also support copy/update with `expr with { Field = value }`. Array and slice literals use `[N]T{...}` or `[]T{...}`. Map literals use `map[K,V]{key: value}`.

### Collection initializers (ADR-0117, issue #479)

A collection construction target followed by a brace-enclosed element list builds and populates a CLR collection in one expression — the analogue of C#'s `new List<int>{1, 2, 3}` / `new Dictionary<K,V>{ ["a"] = 1 }`. The collection type is named at the site (consistent with G#'s `[]T{…}`, `map[K,V]{…}`, and struct-literal traditions); the no-parentheses form `List[T]{…}` is sugar for `List[T](){…}`.

```gsharp
let xs = List[int32]{ 1, 2, 3 }                              // bare elements
let hs = HashSet[int32]{ 1, 2, 2, 3 }                        // set (deduplicated)
let d1 = Dictionary[string, int32]{ "a": 1, "b": 2 }         // key: value pairs
let d2 = Dictionary[string, int32]{ ["a"] = 1, ["b"] = 2 }   // [key] = value entries
let ci = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ "Key": 5 }  // ctor args
```

Each element lowers against a fresh local seeded by the constructor call: a **bare** element `e` becomes `add.Add(e)`, a **keyed** pair `k: v` becomes `add.Add(k, v)`, and an **indexed** entry `[k] = v` becomes the indexer set `add[k] = v` (overwrite semantics; later duplicate keys win). Element, key, and value expressions are converted through ordinary overload resolution. Identifier-keyed `{ x: y }` entries are reserved for struct-literal field initialization, so an identifier/expression dictionary key must use the `["x"] = y` form. A target type with no accessible `Add` (and no settable indexer for the keyed/bare forms) reports `GS0369` rather than failing internally. Spread elements and target-typed, type-name-free literals are deferred (see ADR-0117).


### Switch expressions and patterns

Switch expressions use `:` between the pattern and the arm value (per ADR-0074 / issue #714). The legacy `->` arm separator is still accepted as a one-release migration aid but emits warning `GS0302`. Switch expressions require coverage or a default arm as enforced by diagnostics.

```gsharp
let description = switch value {
case 0: "zero"
case 1: "one"
default: "many"
}
```

Patterns include list-like patterns, property patterns, type tests with `is`, wildcard `_`, relational patterns, and expression patterns.

Patterns may be combined with the **combinators** `and`, `or`, and `not` (issue #992), mirroring C#. `not P` matches when `P` does not; `P and Q` matches when both match (left-to-right, with `Q` evaluated only if `P` matched); `P or Q` matches when either matches (short-circuit). The combinators are contextual keywords usable in pattern position only and remain ordinary identifiers everywhere else. Precedence — matching C# — is `not` (tightest), then `and`, then `or`, so `a or b and c` parses as `a or (b and c)` and `not a and b` as `(not a) and b`; parentheses `( … )` override the default grouping. Combinators compose with every pattern kind, e.g. `case > 0 and < 10:`, `case < 0 or > 100:`, `case _ is Dog and { Name: "Rex" }:`. A type pattern that introduces a binding variable is **not** permitted under `or`/`not` — the variable would not be definitely assigned — and is rejected with `GS0390`; use the discard `_` instead. Smart-cast narrowing of the discriminator is applied under `and` (the union of the sub-patterns' narrowings) and, soundly, only under `or` when **both** branches prove the same narrowing; `not` contributes no positive narrowing. A combined pattern is treated conservatively by exhaustiveness analysis: it never acts as a total/`default` arm, so it cannot by itself make a value-returning `switch` exhaustive.

A pattern in a `switch` arm — in both the expression form and the statement form — may be followed by an optional `when <bool-expr>` guard (issue #991), mirroring C#. `when` is a contextual keyword: it introduces a guard only in this position and remains usable as an ordinary identifier everywhere else. An arm with a guard is selected only when **both** the pattern matches **and** the guard expression evaluates to `true`; otherwise control falls through to the next arm. The guard applies to the whole arm after the (possibly combined) pattern matches, and sees any pattern narrowing / smart-cast in effect for the arm (so the guard of `case x is T when …` observes the discriminator as `T`). A non-`bool` guard is rejected with the standard conversion diagnostic. Because a guarded arm can fail at run time, it never contributes to exhaustiveness: a guarded discard (`case _ when …`) does **not** act as a total/`default` arm, so a value-returning `switch` whose only catch-all is guarded still requires a reachable `default` arm (`GS0176`).

```gsharp
let description = switch value {
case > 0 when value < 10: "small"
case > 0: "big"
default: "nonpositive"
}
```

### Lambda expressions (ADR-0074, ADR-0076, ADR-0119)

`->` introduces a lambda expression. The **canonical** form omits parameter and return types and lets them be **inferred** from the expected delegate type at the use site (ADR-0119): `(x) -> x + 1`, `(a, b) -> a + b`. A single-parameter lambda may drop the parentheses entirely: `x -> x + 1` (issue #932). Parameter types may also be spelled explicitly when desired (`(x int32) -> x + 1`). The body is either a single expression or a brace-delimited block whose trailing expression (or `return`) supplies the lambda value. Lambdas may capture outer locals; the closure machinery is shared with `func` literals.

```gsharp
// Canonical: inferred parameter/return types, target-typed from the use site.
let nums = List[int32]{ 1, 2, 3, 4 }
let evens = nums.Where(x -> x % 2 == 0)          // bare single parameter
let squares = nums.Select((x) -> x * x)          // parenthesized single parameter

func Apply(f Func[int32, int32], v int32) int32 { return f(v) }
let r = Apply((x) -> x + 1, 41)                  // 42 — param type inferred from Func[int32,int32]

let add = (a, b) -> a + b                         // inferred when a target type is present
let triple = (x) -> {
    let doubled = x * 2
    return doubled + x
}

// Alternative: explicit types (no target type required).
let inc = func (x int32) int32 { return x + 1 }
```

Inference is **target-typed**: when an untyped arrow lambda flows into a position whose type is delegate-convertible — a G# `(T) -> R` function type, a named delegate, or a CLR `Func` / `Action` / `Predicate` — the binder extracts that shape and fills in the omitted parameter types and inferred return type. This works for arguments to free functions, instance / interface / static methods (user-declared and imported), and for typed local bindings. Where no target type is available (e.g. a class field initializer, assignment to an existing delegate-typed lvalue, or overload disambiguation that depends on the lambda's shape) the parameter type must be spelled or the explicit `func` form used; see ADR-0119 *Deferred* for the exact cases. A lambda with no inferable parameter type reports `GS0304`.

### If expressions (ADR-0064)

`if` can also appear in value position. The expression form is selected by the parser whenever an `if` appears where a primary expression is expected (let-init, call argument, return operand, switch-expression arm, the trailing position of a block, etc.); when an `if` is the head of a statement the existing statement form is preserved. The same `if` keyword is used for both shapes — there is no separate `if-expression` keyword.

```ebnf
IfExpression  = "if" Expression BlockExpression ( "else" ( IfExpression | BlockExpression ) )? .
BlockExpression = "{" Statement* ( Expression )? "}" .
```

- An `if` used in value position MUST have an exhaustive `else` chain — every branch must produce a value. Missing the terminal `else` reports `GS0276`.
- A branch is a block of the form `{ stmt* expr }`. The trailing expression (the last expression statement of the block) is the branch value; the prefix statements run for their side effects. There is no `yield` keyword on this path — the form mirrors the switch-expression arm, which has no `yield` either. A block with no trailing expression in value position reports `GS0277`.
- `else if` chains nest right-associatively: `if c1 { a } else if c2 { b } else { c }` parses as `if c1 { a } else { if c2 { b } else { c } }`.
- The result type is the common type of all branch tails, chosen by the same `ComputeConditionalCommonType` helper that ADR-0062 uses for the ternary (identity, one-way implicit conversion, numeric widening tie-break, nil/null compatibility). Branch tails are implicitly converted to that result type. Mismatched branch types report `GS0263` (shared with the ternary).
- Only one arm is evaluated at runtime; the other arms are not executed. Lowers to the same `BoundConditionalExpression` that the ternary uses, so no new IL emit paths are involved.
- A throw-expression (`throw e`, Issue #1018) may be used as a ternary branch (`cond ? a : throw e`) or `??` right operand; its bottom (`never`) type takes the sibling operand's type. Inside an *if-expression* or *switch-expression* tail, the trailing position is a block-value/arm context: to exit on the error path you can still place a `throw` **statement** in the block prefix and supply a tail expression of the chosen result type (unreachable at runtime but satisfying the binder), which matches the switch-expression treatment.

```gsharp
let label = if x > 0 { "positive" } else if x < 0 { "negative" } else { "zero" }

let title = if user.IsAdmin {
    log("admin route")
    "Admin Dashboard"
} else {
    "Home"
}
```

The existing if-statement form (`if cond { stmt }` with optional `else`, optional simple-statement initializer) is unchanged; the expression form is purely additive and never reached when `if` heads a statement.

### Expression grammar

```ebnf
Expression        = AssignmentExpression .
Assignment        = identifier "=" Assignment
                  | identifier CompoundAssign Assignment
                  | identifier "[" Expression "]" "=" Assignment
                  | identifier "." identifier "=" Assignment
                  | AccessorExpression ( "+=" | "-=" ) Assignment
                  | RangeExpression .
RangeExpression   = BinaryExpression? ".." ( "^"? BinaryExpression )? | BinaryExpression .  (* standalone System.Range value, issue #1038; `..` binds looser than every binary operator, so `1+2..3+4` is `(1+2)..(3+4)`. A leading `^` is rejected (GS0410); a `^` upper bound is a from-end marker. Suppressed inside an index bound, where IndexArgument owns `..`. *)
BinaryExpression  = PrefixExpression { BinaryOperator PrefixExpression } .
PrefixExpression  = ( "+" | "-" | "!" | "^" | "*" | "&" | "<-" | "await" | "++" | "--" ) PrefixExpression | PostfixExpression .
PostfixExpression = PrimaryExpression { "!!" } { ( "." | "?." ) NameOrCall | ( "[" | "?[" ) IndexArgument "]" } ( "++" | "--" )? ( "with" "{" FieldEqualsList? "}" )? .
(* Prefix `++x`/`--x` and postfix `x++`/`x--` are value-producing expressions (issue #1027). Prefix yields the value AFTER mutation; postfix yields the value BEFORE mutation. The operand must be an assignable variable, field, or indexed element; otherwise GS0402 is reported. They are also valid as standalone statements (`IncDecStmt`). See ADR-0126. *)
IndexArgument     = Expression | Expression? ".." Expression? .  (* the range form slices; see "Range and slice expressions" *)
PrimaryExpression = Literal | identifier | Call | GenericCall | StructLiteral | ArrayLiteral | MapLiteral | FunctionLiteral | LambdaExpression | SwitchExpr | IfExpression | "(" Expression ")" | TupleLiteral | MakeChannel | TypeOf | NameOf .
(* Postfix chains apply to every PrimaryExpression except a bare numeric Literal: `42.Member` is not accepted; use `(42).Member`. See ADR-0054. *)
Literal           = Number | String | InterpolatedString | "true" | "false" | "nil" | char .
InterpolatedString = '"' { InterpolationText | "$$" | "$" identifier | InterpolationHole } '"' .
InterpolationHole = "${" Expression ( "," Expression )? ( ":" FormatText )? "}" .
(* The hole scanner is delimiter-aware: it balances ()[]{}, skips nested string/char literals and comments, and permits newlines, so the "," and ":" clause separators are only recognized at the top level of the hole. See ADR-0055. *)
```

## Statements

### Blocks and expression statements

A block is a braced statement list. Expression statements are accepted for expressions that are meaningful as statements, including calls.

```ebnf
Block     = "{" Statement* "}" .
Statement = Block | Annotation* VariableDecl | IfStmt | IfLetStmt | GuardLetStmt | ForStmt | WhileStmt | DoWhileStmt | LabeledLoopStmt | BreakStmt | ContinueStmt | ReturnStmt | YieldStmt | SwitchStmt | TryStmt | ThrowStmt | UsingStmt | DeferStmt | GoStmt | ScopeStmt | AwaitForRangeStmt | SelectStmt | MultiAssignmentStmt | NullCoalescingAssignmentStmt | IncDecStmt | ChannelSendStmt | ExpressionStmt .
```

### Assignment and variable statements

Bindings are introduced with `let` (immutable) or `var` (mutable); the legacy Go-style `name := expr` short declaration was removed by ADR-0077 / issue #717 and the parser now emits `GS0305` against any occurrence of `:=`. Multi-target assignment supports `a, b = x, y` for identifier target lists; the parallel `a, b := x, y` form is likewise removed (use one `let`/`var` declaration per name). Increment and decrement are available both as statements and, since issue #1027, as value-producing expressions: prefix `++x`/`--x` yields the value after mutation, postfix `x++`/`x--` yields the value before mutation. The operand is evaluated once (the receiver of an indexed or member target is not re-evaluated), so they compose correctly inside short-circuit and branching expressions (e.g. `while i > 0 && i-- > 1 { }`). See ADR-0126.

A `let` or `var` may carry a `ref` prefix to declare a **ref-aliasing local** (ADR-0060 follow-up): `let ref m = arr[i]` produces a local whose IL slot is a managed pointer (`T&`) that aliases the right-hand-side storage. The RHS must be an lvalue (`GS0256`); ref locals are illegal at top level, inside `async` / iterator bodies, and as `const` (`GS0258`). Reads and writes through the alias forward to the underlying storage.

```ebnf
RefLocalDecl = ( "let" | "var" ) "ref" identifier "=" Expression .
```

### If statements

`if` accepts an optional simple statement before a semicolon, then a condition and body, with an optional `else` body.

```ebnf
IfStmt = "if" ( SimpleStmt ";" )? Expression Statement ( "else" Statement )? .
```

### `if let` and `guard let` binding statements (ADR-0071)

`if let` and `guard let` strip the nullable layer from a value and bind a fresh
identifier to the underlying non-null view:

```ebnf
IfLetStmt        = "if" LetBindingList Statement ( "else" Statement )? .
GuardLetStmt     = "guard" LetBindingList "else" Block .
LetBindingList   = LetBindingClause ( "," LetBindingClause )* .
LetBindingClause = "let" identifier TypeClause? "=" Expression .
```

The initializer expression of each `let` clause must have a nullable type
(`T?`); otherwise the binder reports `GS0296`. Inside the then-block of
`if let` (or in the remainder of the enclosing block after `guard let`), the
binding is observable at the underlying non-null type `T` via the smart-cast
machinery of ADR-0069.
Multiple comma-separated bindings narrow all-or-nothing — the then-block runs
only when every clause is non-nil. The else-block of `guard let` MUST exit
the enclosing scope (`return`, `throw`, `break`, `continue`, or a block whose
last statement does); otherwise the binder reports `GS0297`. `guard` is a
reserved keyword.

### Null-coalescing compound assignment `??=` (ADR-0072)

`??=` writes the right-hand side into the left-hand side **only when the
current value of the left-hand side is `nil`**. The right-hand side is
short-circuited (not evaluated) when the lvalue is already non-nil.

```ebnf
NullCoalescingAssignmentStmt = Expression "??=" Expression .
```

The left-hand side must be of a nullable type (`T?`, for either a nullable
reference type or `Nullable<T>`); a non-nullable lvalue reports `GS0298`.
The accepted lvalue shapes are the same as for the simple assignment
statement: local / parameter / package-level variable, instance field on a
struct or class, auto-property or computed property with a setter, CLR
property or non-init-only CLR field, and indexer access (G#-native or CLR).
A non-assignable target reports `GS0299`. The usual `GS0127` (read-only
lvalue) and conversion diagnostics also apply.

`??=` is a statement, not an expression — it never appears as the value of
another expression. The semantics, including single evaluation of the
receiver and any index expressions, are:

```text
a ??= b
    is equivalent to
{
    let __recv = <receiver-of-a>     // only if a's receiver is non-trivial
    let __idx  = <index-of-a>        // only for indexer targets
    if __recv.member /* [__idx] */ == nil {
        __recv.member /* [__idx] */ = b
    }
}
```

For nullable value types (`int32?`, `bool?`, …) the same shape applies; the
nil-comparison reuses the existing `==` lowering for `Nullable<T>` so the
write only fires when `HasValue == false`.

### Switch statements

Switch statement cases use block bodies and never fall through. The `fallthrough` keyword is reserved and parsed only to report an unsupported-fallthrough diagnostic.

```ebnf
SwitchStmt = "switch" Expression "{" SwitchCase* "}" .
SwitchCase = "case" Pattern [ "when" Expression ] Block | "default" Block .
```

When an arm pattern is a type-pattern `<ident> is T` (or any pattern that proves the discriminator's runtime type), the discriminator expression is flow-narrowed to `T` inside the arm body in addition to the bound arm variable — see *Smart casts (flow narrowing)* below.

### Smart casts (flow narrowing)

Ref: ADR-0069 and its issue #712 addendum.

A successful `is` (or `!is`) test against a *stable narrowable receiver* — a local, a parameter, or a read-only top-level `let` binding — flow-narrows that receiver to the tested type for the rest of the enclosing flow region. The narrowing applies to member lookup, overload resolution, conversion, and emit. The same machinery composes through `!`, `&&`, `||`, `if`/`else`, `switch` arms, `if let` / `guard let`, and the early-exit lift.

```gsharp
if a is Dog {
    a.Bark()                      // a narrowed to Dog inside the then-block
}

if a !is Dog { return }
a.Bark()                          // a narrowed to Dog in the rest of the block

if a is Dog && a.Name != "" {
    Console.WriteLine(a.Bark())   // && threads the left narrowing into the right operand
}

if !(a is Dog) || silent { return }
a.Bark()                          // || + early-exit: a is Dog AND silent is false here

switch a {
    case d is Dog { Console.WriteLine(a.Bark()) }    // a narrowed to Dog in this arm
    case c is Cat { Console.WriteLine(a.Purr()) }    // a narrowed to Cat in this arm
    default       { return }
}
```

Rules summary:

- `!` flips which branch sees the narrowing: `!(a is T)` narrows `a` to `T` in the *else*-branch (and in the rest of the block when the then-branch unconditionally exits).
- `&&` threads the left operand's then-frame into the right operand and into the combined then-branch.
- `||` is the De Morgan dual of `&&`: the combined then-frame is the *intersection* of both operands' then-frames; the combined else-frame is the *merge* of both operands' else-frames; the right operand is bound with the left's else-frame.
- A `switch` arm pattern of the shape `<ident> is T` narrows the discriminator inside the arm body. When the switch is exhaustive (has a `default` or discard arm) AND every non-exiting arm contributes the same `{discriminator → T}` narrowing, that narrowing is lifted into the rest of the enclosing block after the switch.
- Reassignment to a narrowed receiver inside the narrowed region drops the narrowing for the remainder of the region; the same applies if the receiver is captured by a closure (the closure body binds the receiver at its declared type). Fields, properties, and indexed expressions are never narrowed because their reads are not idempotent.

### For loops and while-style loops

G# has `for`, `for in`, `while`, and `do`-`while` forms. The legacy
`for v := range coll`, `for k, v := range dict`, and `for i := lo ... hi`
spellings were removed by ADR-0077 / issue #717; use the `in` forms.

```ebnf
ForStmt = "for" Statement
        | "for" Expression Statement
        | "for" SimpleStmt? ";" Expression? ";" SimpleStmt? Statement
        | "for" identifier ( "," identifier )? "in" Expression Statement
        | "for" identifier "in" Expression "..." Expression Statement .

WhileStmt    = "while" Expression Statement .
DoWhileStmt  = "do" Block "while" Expression .
```

The optional `SimpleStmt` of the C-style three-part `for` accepts a `var`
or `let` declaration (e.g. `for var i = 0; i < n; i++`), an assignment, an
increment / decrement, or an expression statement.

A controlling expression in a statement header — the `for` condition or
post-statement, the condition-only `for`/`while` condition, the `if`
condition, and the `switch`/`match` subject — never treats a trailing `{` as
a composite-literal brace. As in Go, the `{` opens the statement body. This
applies even when the controlling expression ends in an indexer
(`for var s = 0; s < n; s += arr[s] { … }`) or a generic-composite shape
(`name[args] { … }`): the brackets bind as an indexer / type-argument list and
the following `{` opens the body. Composite literals are still parsed normally
in ordinary expression position (`var b = Box[int32]{Value: 42}`,
`Point{X: 1, Y: 2}`) and inside a nested parenthesized/bracketed/argument
context within a header (issue #1023).

`while` evaluates its condition first and runs the body while the condition is
true. `do`-`while` always runs the body once before evaluating the condition;
the body must be a block.

### Labeled loops, break, and continue (ADR-0070)

`for`, `while`, and `do`-`while` may be prefixed with `identifier ":"` to
declare a label. `break identifier` and `continue identifier` then target the
matching enclosing loop instead of the innermost one. Unlabeled
`break`/`continue` keep their existing innermost-loop semantics. The optional
label after `break`/`continue` must appear on the same source line as the
keyword (mirroring `return` value parsing).

Diagnostics:

- **GS0293** — `break`/`continue` names a label that is not in scope on the
  enclosing loop stack.
- **GS0294** — a label declaration prefixes a statement that is not a loop.
- **GS0295** — *warning*. A loop label shadows another label of the same name
  on the enclosing loop stack.
- **GS0120** — pre-existing — `break`/`continue` used outside any loop.

```ebnf
LabeledLoopStmt   ::= identifier ':' ( ForStmt | WhileStmt | DoWhileStmt )
```

### Return and yield

`return` may have no expression, one expression, or a comma-separated expression list, which is represented as a tuple literal. In a `ref`-returning function (`func f(...) ref T`), the return statement form is `return ref <lvalue>` — plain `return expr` reports `GS0252`, and a non-lvalue operand reports `GS0253`. `yield expr` is contextual and valid in iterator functions returning `sequence[T]` or async sequence forms as appropriate.

### Defer and using

`defer expr` registers a deferred call. The parser accepts an expression, but binding requires a call expression. `using` introduces a resource variable declaration and requires a disposable value.

```ebnf
UsingStmt = "using" VariableDecl .
DeferStmt = "defer" Expression .
```

### Go, scope, channel send and receive, and select

`go expr` starts a concurrent call; binding requires the operand to be a call. `scope { ... }` is structured concurrency and joins registered child tasks at scope exit. Channel receive is a prefix expression `<-ch`; channel send is a statement `ch <- value`. `select` supports default, receive-discard, receive-bind (via `case let v = <-ch`), and send cases.

The `go`, `chan T`, `<-` (send and receive), `select`, `close(ch)`, and `make(chan T)` forms are the **Go-flavored concurrency surface** and are gated behind a per-file `import Gsharp.Extensions.Go` (ADR-0082). The binder reports `GS0316` at each offending keyword/operator (`go`, `chan`, `<-`, `select`, `close`) when the import is absent in the same compilation unit. `scope` itself is **not** gated. The gate is always opt-in and is independent of `/noimplicitimports`.

```ebnf
GoStmt     = "go" Expression .
ScopeStmt  = "scope" Block .
SelectStmt = "select" "{" SelectCase* "}" .
SelectCase = "default" Block
           | "case" "<-" Expression Block
           | "case" "let" identifier "=" "<-" Expression Block
           | "case" Expression "<-" Expression Block .
```

### Throw, try, catch, and finally

G# uses CLR-style exceptions. A `try` statement must have at least one catch or finally semantically.

```ebnf
TryStmt       = "try" Block CatchClause* FinallyClause? .
CatchClause   = "catch" "(" identifier TypeClause? ")" Block .
FinallyClause = "finally" Block .
ThrowStmt     = "throw" Expression .
```

#### Throw expressions (Issue #1018)

`throw` is also usable as an **expression** (a *throw-expression*), mirroring C#.
A throw-expression `throw e` has the bottom (`never`) type, which is implicitly
convertible to **any** target type, and it never produces a value — it always
transfers control by raising `e`. It is accepted in the common expression
positions:

- the right-hand side of `??` — `s ?? throw Exception("null")`;
- a branch of the conditional operator — `cond ? a : throw Exception("nope")`;
- a returned operand — `return throw Exception(...)`;
- an arrow/lambda body — `(v string?) -> v ?? throw Exception("null")`;
- an argument — `f(s ?? throw Exception(...))`.

The surrounding `??` / conditional takes the **sibling** operand's type
(`s ?? throw e` has the type of `s`'s underlying type; `cond ? a : throw e` has
the type of `a`). The thrown operand must be a `System.Exception` (or derived),
exactly as for the throw statement; otherwise `GS0155` ("cannot convert … to
System.Exception") is reported. The emitter lowers a throw-expression to the
operand followed by CIL `throw`; because that never returns, the code after it
(the `??` / conditional merge point reached only from the other branch) is
unreachable and the emitted IL is verifiable.

A bare `throw e` at statement start is still the throw **statement** — the
statement parser intercepts it before expression parsing — so existing code is
unaffected.

```ebnf
ThrowExpr     = "throw" Expression .
```

### Await and async iteration

`await expr` is a prefix expression and must appear in an async context with an awaitable operand. `await for` iterates asynchronous sequences.

```ebnf
AwaitForRangeStmt = "await" "for" identifier "in" Expression Block .
```

## Concurrency

`go` launches concurrent function calls. In the interpreter, `go` uses `Task.Run`; outside `scope`, exceptions can be unobserved, while inside `scope` child tasks are registered and joined when the scope exits. The interpreter serializes some evaluation through locks, so it is a correctness implementation rather than a performance model. The emit path supports channels, `go`, `scope`, and `select` through lowering and CLR primitives.

Channels are typed, can be buffered, and support `close`, send, receive, and `select`. Receiving from a closed channel yields the element default value in the implemented channel path, as shown by the `Channels` sample.

Per ADR-0082 (issue #722), the production concurrency surface is `scope` + `async`/`await`. The Go-flavored shapes (`go`, `chan T`, `<-` send, `<-` receive, `select`, `close(ch)`, and `make(chan T)`) remain fully supported but are opt-in: each consuming file must contain `import Gsharp.Extensions.Go`. The binder emits `GS0316` for each gated form when the import is missing.

## Async and iterators

`async func` declarations and literals are supported. The emit path lowers async methods and lambdas to state machines, including exception handler rewriting, spill management, and capture analysis. The interpreter blocks on awaiters and `ValueTask` results.

Iterator functions return `sequence[T]` and contain `yield`. Async sequences use `async sequence[T]` and `await for`. The emit path has synchronous and asynchronous iterator state-machine rewriters; the interpreter executes async iteration by blocking.

## CLR interop semantics

G# imports can resolve CLR namespaces and metadata references. CLR primitive types map to G# built-ins when possible; other CLR types are represented as imported types. The binder and evaluator support imported constructors, static and instance methods, fields, properties, indexers, events, delegates, method groups, operator overloads, and conversion operators. G# function values can convert to compatible CLR delegates such as `Action`, `Func`, named delegates, and `Predicate`, and can widen to `System.Delegate` or `System.MulticastDelegate`.

Attributes use `@Name(...)` and optional use-site targets such as `@field:`, `@param:`, and `@return:`. The implementation recognises attributes and emits user attributes through CLR `CustomAttribute` rows. Per ADR-0086, a `func` declaration annotated with `@DllImport("libname", ...)` whose body is the single token `;` is accepted as a P/Invoke declaration and emitted as a CLR `PinvokeImpl` method with the matching `ImplMap` / `ModuleRef` rows (see [Native interop](#native-interop-pinvoke) below).

## Native interop (P/Invoke)

ADR-0086 / issue #727 adds attribute-driven P/Invoke. A top-level `func` declaration whose body is a single `;` token and which carries an `@DllImport("libname", ...)` annotation is bound as a P/Invoke stub: there is no managed body, and the compiler emits a CLR `PinvokeImpl` method with an `ImplMap` row pointing at the deduplicated `ModuleRef` for `libname`.

```gs
package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func NativeStrLen(text string) nint;

Console.WriteLine(NativeStrLen("Hello, world!"))
```

Supported attribute knobs (each maps directly to the corresponding ECMA-335 `ImplMap` bit or `MethodImportAttributes` enum value): `EntryPoint`, `CharSet`, `SetLastError`, `CallingConvention`, `ExactSpelling`, `PreserveSig`, `BestFitMapping`, `ThrowOnUnmappableChar`. Defaults match the CLR's `[DllImport]` defaults: ANSI charset, WinAPI calling convention, `SetLastError=false`, `PreserveSig=true`, and `ExactSpelling` defaulting to `(CharSet == Auto)`.

Supported v1 marshalling types: every primitive integer (`int8`/`16`/`32`/`64`, `uint8`/`16`/`32`/`64`), `nint`/`nuint`, `float32`/`float64`, `bool`, `char`, `string` (governed by `CharSet`), single-element `*T` byref-style pointers (where `T` is primitive), plain unmanaged `*T` pointer parameters in an `unsafe` extern (ADR-0122 / issue #1014; pointee a blittable primitive, another pointer, or a blittable user/value struct — issue #1034 — marshalled as a native pointer — e.g. `void* pBuffer` ≡ `*void` (a void-element pointer; ADR-0122 §3 / issue #1033), `byte* pBuf` ≡ `*uint8`, `int* pRead` ≡ `*int32`, `Point* p` ≡ `*Point`), and slices of primitives. Anything outside this set surfaces as GS0323. Struct marshalling, function-pointer marshalling, and custom marshallers are deferred follow-ups.

A P/Invoke declaration may not be `async`, generic, an extension method, an instance method, a member of a `shared` block, or ref-returning; each violation is reported as GS0326. A function with a `;` body but no `@DllImport` is rejected as GS0325. A function with both `@DllImport` and a managed body is rejected as GS0324. The full diagnostic catalogue (GS0322–GS0329) is listed in the [Diagnostics reference](./diagnostics).

ADR-0094 / issue #760 lifts the original blanket rejection of `ref` / `out` / `in` parameters on P/Invoke declarations: a parameter may now carry a ref-kind modifier provided the pointee type is blittable (the same blittable primitives as the by-value path — `int8`…`int64`, `uint8`…`uint64`, `nint`/`nuint`, `float32`/`float64` — or a `@StructLayout(LayoutKind.Sequential|Explicit)`-annotated struct whose fields are all blittable per the rules below). The runtime marshals the byref slot as a managed pointer `T*` to the unmanaged callee — the canonical shape for libc APIs that write through an out-pointer (`time(time_t *)`, `clock_gettime(int, struct timespec *)`). Non-blittable byref pointees (`bool`, `char`, `string`, decimal, slices, sequences, classes, nullable values) are rejected with the new GS0352 diagnostic; non-blittable struct pointees continue to flow through GS0349. Both `@DllImport` and `@LibraryImport` support byref parameters; the `@LibraryImport` outer wrapper forwards the address through both stub halves.

The modern source-generator-shaped `@LibraryImport(...)` form is also accepted on `;`-bodied `func` declarations, alongside `@DllImport`. Under `@LibraryImport`, the compiler generates an explicit managed marshalling stub (outer wrapper) that calls a hidden blittable inner P/Invoke — the runtime never auto-marshals at the unmanaged boundary, which makes the resulting assemblies AOT-friendly and verifiable under `ilverify`. The attribute knobs are `EntryPoint`, `SetLastError`, `StringMarshalling`, and `StringMarshallingCustomType`; `CharSet` and `CallingConvention` do not exist on `@LibraryImport`. Whenever a `string` parameter is present, `StringMarshalling: StringMarshalling.Utf8` or `StringMarshalling.Utf16` must be specified explicitly (GS0344). `string` return values are rejected in v1 (GS0345). Mixing `@DllImport` and `@LibraryImport` on the same declaration is GS0342. See ADR-0092 and the [Diagnostics reference](./diagnostics) for the full surface.

### Struct and class marshalling

ADR-0093 / issue #759 lifts the v1 deferral on struct- and class-marshalling. A `struct` or `class` declaration may carry an `@StructLayout(LayoutKind.Sequential)` or `@StructLayout(LayoutKind.Explicit)` annotation, and the fields of an `Explicit`-layout type each carry an `@FieldOffset(N)` annotation. `LayoutKind.Auto` is rejected (GS0346) — the CLR may reorder fields under `Auto`, which breaks the bit-for-bit ABI contract that P/Invoke relies on. The optional `Pack` and `Size` named arguments are forwarded to the emitted `ClassLayout` row.

```gs
@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

@StructLayout(LayoutKind.Explicit, Size: 8)
struct LargeInteger {
    @FieldOffset(0) var LowPart  uint32
    @FieldOffset(4) var HighPart int32
    @FieldOffset(0) var QuadPart int64
}
```

Both `@StructLayout` and `@FieldOffset` are CLR *pseudo-custom attributes* — the runtime reconstructs them at reflection time from the `ClassLayout` and `FieldLayout` metadata-table rows, so the emitter writes those rows directly and skips the normal `CustomAttribute` encoding (decompilers therefore see exactly one `[StructLayout]` per type, not two).

A struct or class that appears in a P/Invoke signature must be *blittable*: every field is a primitive integer/float, an `nint` / `nuint`, a pointer (`*T`), or a blittable nested struct. `bool`, `char`, `string`, `decimal`, slices, sequences, and unannotated classes are non-blittable in v1; the binder rejects them with GS0349. Per-field `[MarshalAs]` for non-blittable fields remains a follow-up.

Classes follow a stricter rule: a `class` must carry an explicit `@StructLayout(LayoutKind.Sequential|Explicit)` annotation before it can appear in a P/Invoke signature (the default class layout is `Auto`), and even then it can only flow *by reference* — using a class as a P/Invoke return type is rejected with GS0351. Return a struct or `nint` instead. The full diagnostic catalogue (GS0346–GS0351) is listed in the [Diagnostics reference](./diagnostics); see ADR-0093 for the design rationale and the blittability classification rules.

### Function-pointer marshalling

ADR-0095 / issue #761 lifts the v1 deferral on function-typed and delegate-typed P/Invoke parameters and returns. Two shapes are supported:

**Shape A — managed delegate callbacks.** A `type Name = delegate func(...) R` declaration annotated with `@UnmanagedFunctionPointer(CallingConvention.Cdecl)` (or any of `Stdcall`, `Thiscall`, `Fastcall`) may appear as a P/Invoke parameter type. The runtime synthesizes a stable C-ABI thunk via `Marshal.GetFunctionPointerForDelegate`. A delegate-typed P/Invoke parameter without `@UnmanagedFunctionPointer` is rejected with GS0353.

**Shape B — raw function pointers.** A type clause of the form `unmanaged[CC] (T1, T2, ...) -> R` denotes a CLR function-pointer type (encoded as `ELEMENT_TYPE_FNPTR` in the metadata blob). The bracketed calling-convention slot is mandatory; omitting it is GS0356. The four accepted conventions are `Cdecl`, `Stdcall`, `Thiscall`, `Fastcall` — any other identifier is rejected with GS0354. Returning a managed delegate from a P/Invoke is rejected with GS0355 because the runtime cannot infer the lifetime contract; use Shape B or `nint` + `Marshal.GetDelegateForFunctionPointer` instead.

```gs
@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Int64Comparer = delegate func(a nint, b nint) int32

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp Int64Comparer) void;

@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
```

GC contract (Shape A): the CLR keeps the delegate rooted only for the duration of `Marshal.GetFunctionPointerForDelegate` + the inner native call. The caller must hold an explicit reference (and ideally call `GC.KeepAlive` at the end of the scope) for as long as the native side may invoke the callback. The full diagnostic catalogue (GS0353–GS0356) is listed in the [Diagnostics reference](./diagnostics); see ADR-0095 for the design rationale and worked examples.

### Per-parameter `@MarshalAs` overrides

ADR-0096 / issue #762 lets a P/Invoke parameter opt into a custom unmanaged marshalling form via `@MarshalAs(UnmanagedType.…)`. Without `@MarshalAs`, each parameter is marshalled using the implicit ADR-0086 rule for its G# type; `@MarshalAs` is the override.

```gs
@DllImport("user32", EntryPoint: "MessageBoxW")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;

@DllImport("libfoo", EntryPoint: "sum_buf")
func native_sum_buf(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;

@DllImport("libfoo", EntryPoint: "set_flag")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
```

The v1 supported `UnmanagedType` set is `LPStr`, `LPWStr`, `LPUTF8Str`, `BStr`, `LPArray`, `SafeArray`, `I1`, `U1`, `I2`, `U2`, `I4`, `U4`, `I8`, `U8`, `Bool`, `VariantBool`, `SysInt`, `SysUInt`, `Struct`, `ByValTStr` (requires `SizeConst:`), `ByValArray` (requires `SizeConst:`). `LPArray` requires `SizeConst:` and/or `SizeParamIndex:`. Anything outside the set (`CustomMarshaler`, `IUnknown`, `IDispatch`, `FunctionPtr`, `Currency`, `LPStruct`) is rejected with GS0357. The binder enforces a per-UnmanagedType / G#-type compatibility table; mismatches surface as GS0358. Missing required knobs (`SizeConst:` for inline forms, `SizeParamIndex:` for `LPArray`) surface as GS0359. `@MarshalAs` on a non-P/Invoke function — or on a `@LibraryImport` *string* parameter, which is governed by the function-wide `StringMarshalling:` knob — surfaces as GS0360.

`@MarshalAs` is encoded as a CLR `FieldMarshal` table row (ECMA-335 II.23.4) and the `HasFieldMarshal` flag on the Param row; the emitter does not also write a `CustomAttribute` row, matching C#'s `[MarshalAs]` shape. The full diagnostic catalogue (GS0357–GS0360) is listed in the [Diagnostics reference](./diagnostics); see ADR-0096 for the design rationale, the FieldMarshal blob byte tables, and the LibraryImport-string interaction.

Interpolated strings interoperate with the CLR formatting types. By default they lower to `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler` (value-type holes are not boxed); a string targeted at `IFormattable` or `FormattableString` lowers to `FormattableStringFactory.Create` for deferred, culture-aware formatting; and a parameter annotated with `[InterpolatedStringHandler]` receives the handler directly, including `[InterpolatedStringHandlerArgument]` forwarding.

## Documentation comments

ADR-0057 introduces Markdown-authored documentation comments that round-trip losslessly to CLR XML doc. A documentation comment is a run of consecutive `///` lines; each line contributes one paragraph of authored text after one optional leading space is stripped. The block is attached to the immediately following declaration (free function, type, member, or top-level constant) and is parsed as Markdown plus a small set of `@`-prefixed block tags drawn from the CLR XML-doc vocabulary.

Recognised tags:

| Tag | Meaning |
| --- | --- |
| `@summary` | Default; usually elided. Prose-only `///` blocks become the summary. |
| `@param name` | Documents parameter `name`. |
| `@typeparam name` | Documents type parameter `name`. |
| `@returns` | Documents the return value. |
| `@value` | Documents a property's value. |
| `@remarks` | Long-form remarks. |
| `@exception TypeName` | Documents a thrown exception. |
| `@seealso TypeName` | Cross-reference. |
| `@inheritdoc` | Inherit documentation from a base/interface member. |

Authors can drop raw `<...>` XML through unchanged by writing it inside a fenced ```` ```xmldoc ```` code block, for constructs Markdown cannot express.

The compiler renders the merged documentation in hover for both G# declarations and imported CLR APIs (their `.xml` doc files are ingested and rendered identically). Diagnostics:

| Code | Severity | Cause |
| --- | --- | --- |
| `GS0227` | Warning | Documentation comment is not attached to a declaration. |
| `GS0228` | Warning (opt-in) | Missing documentation on a public member. |
| `GS0229` | Warning | `@param` / `@typeparam` name does not match any parameter. |
| `GS0230` | Warning | Unsupported documentation Markdown construct. |
| `GS0231` | Warning | Unknown documentation tag. |

## Appendix: full parser grammar

```ebnf
(* Several terminals below are CONTEXTUAL identifiers, not reserved keywords:
   data, inline, ref, scoped, delegate, convenience, init, deinit, shared, prop,
   event, get, set, add, remove, raise, make, typeof, nameof, unmanaged, with,
   base, the variance markers in/out, and the parameter ref-kinds ref/out/in.
   They are written as quoted terminals here for brevity. *)

CompilationUnit   ::= PackageDecl? ImportDecl* Member* EOF
PackageDecl       ::= 'package' identifier ('.' identifier)*
ImportDecl        ::= 'import' (identifier '=')? identifier ('.' identifier)*
Member            ::= Annotation* Accessibility?
                      ( Async? FunctionDecl
                      | AggregateDecl
                      | TypeAliasDecl
                      | DelegateDecl
                      | VariableDecl                 (* requires Accessibility *)
                      | GlobalStatement )
Accessibility     ::= 'public' | 'internal' | 'protected' | 'private'  (* 'protected' is valid only on members of an inheritable 'open class'; see issue #950 *)
Async             ::= 'async'
Annotation        ::= '@' (AnnotationTarget ':')? identifier ('.' identifier)* ('(' Arguments? ')')?
AnnotationTarget  ::= 'field' | 'param' | 'return' | 'type' | 'method' | 'property' | 'event' | 'module' | 'assembly' | 'genericparam'

FunctionDecl      ::= 'func' ReceiverClause? (identifier | OperatorName | ConversionOperatorName) TypeParamList? '(' Parameters? ')' 'ref'? TypeClause? (Block | ';')
                      (* ';' is the no-body marker: P/Invoke (ADR-0086) and abstract members (issue #881) *)
ReceiverClause    ::= '(' Parameter ')'
OperatorName      ::= 'operator' OperatorToken
ConversionOperatorName ::= 'operator' ('implicit' | 'explicit')
TypeParamList     ::= '[' TypeParameter (',' TypeParameter)* ']'
TypeParameter     ::= ('in' | 'out')? identifier ConstraintRef? ConstraintFlag*
ConstraintRef     ::= identifier TypeArgList?           (* legacy slot: any | comparable | interface name (G# or imported CLR); generic-instantiated e.g. [T IAdd[T]] (ADR-0089) or [T IComparable[T]] (issue #943) *)
ConstraintFlag    ::= 'class' | 'struct' | 'new' '(' ')'  (* repeatable flag constraints, ADR-0097 *)
Parameters        ::= Parameter (',' Parameter)*
Parameter         ::= Annotation* 'scoped'? ('ref' | 'out' | 'in')? identifier '...'? TypeClause ('=' Expression)?

TypeAliasDecl     ::= 'type' identifier TypeParamList? '=' identifier
DelegateDecl      ::= 'type' identifier TypeParamList? '=' 'delegate' 'func' '(' Parameters? ')' TypeClause?   (* named CLR delegate, ADR-0059 *)
AggregateDecl     ::= ClassDecl | StructDecl | EnumDecl | InterfaceDecl    (* leading modifiers may appear in any order; per-kind validity is enforced by the binder *)
ClassDecl         ::= ('open' | 'sealed')? 'data'? 'class' identifier TypeParamList? PrimaryCtor? BaseClause? StructBody?
StructDecl        ::= 'data'? 'inline'? 'ref'? 'struct' identifier TypeParamList? PrimaryCtor? BaseClause? StructBody?
EnumDecl          ::= 'sealed'? 'enum' identifier '{' EnumMemberList? '}'
InterfaceDecl     ::= 'sealed'? 'interface' identifier TypeParamList? InterfaceBaseClause? InterfaceBody
InterfaceBaseClause ::= ':' TypeClause (',' TypeClause)*               (* issue #1006: base interfaces; each must resolve to an interface *)
PrimaryCtor       ::= '(' Parameters? ')'
BaseClause        ::= ':' TypeClause ('(' Arguments? ')')? (',' TypeClause)*
EnumMemberList    ::= EnumMember ((',' | ';') EnumMember)* (',' | ';')?
EnumMember        ::= Annotation* identifier ('(' Parameters? ')')?       (* payload => discriminated-union case (ADR-0078) *)

StructBody        ::= '{' StructMember* '}'
StructMember      ::= Annotation*
                      ( Accessibility? OpenOrOverride* (MethodDecl | PropertyDecl | EventDecl)
                      | Accessibility? ConstructorDecl
                      | DeinitDecl
                      | SharedBlock
                      | FieldDecl )
OpenOrOverride    ::= 'open' | 'override'
ConstructorDecl   ::= 'convenience'? 'func'? 'init' '(' Parameters? ')' (':' identifier '(' Arguments? ')')? Block
DeinitDecl        ::= 'deinit' Block                     (* class-only; no parameters or return type *)
SharedBlock       ::= 'shared' '{' SharedMember* '}'
SharedMember      ::= Annotation* Accessibility? (Async? MethodDecl | PropertyDecl | EventDecl | FieldDecl)
MethodDecl        ::= FunctionDecl
FieldDecl         ::= Accessibility? ('var' | 'let') identifier TypeClause ('=' Expression)?
PropertyDecl      ::= 'prop' (identifier | IndexerHeader) TypeClause PropertyBody?
IndexerHeader     ::= 'this' '[' Parameters ']'   (* ADR-0118: user indexer member; emitted as CLR default 'Item' property *)
PropertyBody      ::= '{' PropertyAccessor* '}'
PropertyAccessor  ::= ('get' | 'set' ('(' identifier ')')?) (Block | ';')?
EventDecl         ::= 'event' identifier TypeClause EventBody?
EventBody         ::= '{' EventAccessor* '}'
EventAccessor     ::= ('add' | 'remove' | 'raise') (Block | ';')?
InterfaceBody     ::= '{' InterfaceMember* '}'
InterfaceMember   ::= Annotation* (InterfaceMethodDecl | PropertyDecl | EventDecl | InterfaceSharedBlock)
InterfaceMethodDecl ::= 'private'? 'func' identifier TypeParamList? '(' Parameters? ')' TypeClause? (Block | ';')
                      (* Block => default-interface method (ADR-0085); ';' => abstract no-body marker (issue #881) *)
InterfaceSharedBlock ::= 'shared' '{' InterfaceSharedMember* '}'           (* static-virtual interface members, ADR-0089 *)
InterfaceSharedMember ::= 'private'? 'func' identifier TypeParamList? '(' Parameters? ')' TypeClause? (Block | ';')
                      | 'prop' identifier TypeClause ( '{' PropertyAccessor* '}' | ';' )   (* static-virtual interface property, ADR-0089 / issue #1019 *)

TypeClause        ::= identifier ('.' identifier)* TypeArgList? '?'?
                    | '[' Number? ']' identifier ('.' identifier)* '?'?
                    | '(' TypeClause (',' TypeClause)+ ')' '?'?                          (* tuple type *)
                    | '(' FnTypeParamList? ')' '->' TypeClause '?'?                       (* arrow function type, ADR-0075 *)
                    | 'async' '(' FnTypeParamList? ')' '->' TypeClause '?'?
                    | 'map' '[' TypeClause ',' TypeClause ']' '?'?                        (* canonical, ADR-0104 *)
                    | 'map' '[' TypeClause ']' TypeClause '?'?                            (* legacy; GS0366 *)
                    | 'chan' TypeClause '?'?
                    | 'sequence' '[' TypeClause ']' '?'?
                    | 'async' 'sequence' '[' TypeClause ']' '?'?
                    | 'func' '(' FnTypeParamList? ')' TypeClause? '?'?                    (* deprecated; GS0303 *)
                    | 'async' 'func' '(' FnTypeParamList? ')' TypeClause? '?'?            (* deprecated; GS0303 *)
                    | '*' TypeClause '?'?                                                  (* pointer type, ADR-0039 *)
                    | 'unmanaged' ('[' identifier ']')? '(' TypeClauseList? ')' '->' TypeClause   (* function pointer, ADR-0095 *)
FnTypeParamList   ::= '...'? TypeClause (',' '...'? TypeClause)*                          (* per-slot variadic, ADR-0102 *)
TypeArgList       ::= '[' TypeClause (',' TypeClause)* ']'
TypeClauseList    ::= TypeClause (',' TypeClause)*

Block             ::= '{' Statement* '}'
Statement         ::= Block
                    | Annotation* VariableDecl
                    | IfStmt | IfLetStmt | GuardLetStmt | ForStmt | WhileStmt | DoWhileStmt | LabeledLoopStmt | BreakStmt | ContinueStmt | ReturnStmt | YieldStmt
                    | SwitchStmt | FallthroughStmt | TryStmt | ThrowStmt | UsingStmt | AwaitUsingStmt | DeferStmt | GoStmt | ScopeStmt
                    | AwaitForRangeStmt | SelectStmt | MultiAssignmentStmt
                    | IncDecStmt | ChannelSendStmt | ExpressionStmt
VariableDecl      ::= ('const' | 'let' | 'var') 'scoped'? 'ref'? identifier TypeClause? '=' Expression
                    | 'var' 'scoped'? identifier TypeClause                                  (* no initializer; binds the type's zero value *)
                    | 'let' '(' identifier (',' identifier)* ')' '=' Expression               (* tuple deconstruction *)
                    | 'let' '{' identifier '=' identifier (',' identifier '=' identifier)* '}' '=' Expression   (* named deconstruction *)
MultiAssignmentStmt ::= identifier (',' identifier)+ '=' Expression (',' Expression)*
IncDecStmt        ::= identifier ('++' | '--')
FallthroughStmt   ::= 'fallthrough'                       (* recognised then reported as unsupported, ADR-0013 *)

IfStmt            ::= 'if' (SimpleStmt ';')? Expression Statement ('else' Statement)?
IfLetStmt         ::= 'if' LetBindingList Statement ('else' Statement)?
GuardLetStmt      ::= 'guard' LetBindingList 'else' Statement
LetBindingList    ::= LetBindingClause (',' LetBindingClause)*
LetBindingClause  ::= 'let' identifier TypeClause? '=' Expression
ForStmt           ::= 'for' Block
                    | 'for' Expression Block
                    | 'for' SimpleStmt? ';' Expression? ';' SimpleStmt? Block
                    | 'for' identifier (',' identifier)? 'in' Expression Block
                    | 'for' identifier 'in' Expression '...' Expression Block
WhileStmt         ::= 'while' Expression Statement
DoWhileStmt       ::= 'do' Statement 'while' Expression
LabeledLoopStmt   ::= identifier ':' Statement            (* the binder requires the inner statement to be a loop, GS0294 *)
SimpleStmt        ::= ('var' | 'let') 'scoped'? 'ref'? identifier TypeClause? '=' Expression
                    | 'var' 'scoped'? identifier TypeClause
                    | IncDecStmt
                    | ExpressionStmt                       (* includes Assignment, compound assignment, and '??=' *)
BreakStmt         ::= 'break' identifier?                  (* an optional label must be on the same source line *)
ContinueStmt      ::= 'continue' identifier?
ReturnStmt        ::= 'return' ('ref' Expression | Expression (',' Expression)*)?   (* 'ref' return, ADR-0060 *)
YieldStmt         ::= 'yield' Expression

SwitchStmt        ::= 'switch' Expression '{' SwitchCase* '}'
SwitchCase        ::= 'case' Pattern ('when' Expression)? Block | 'default' Block
SwitchExpr        ::= 'switch' Expression '{' SwitchArm* '}'
SwitchArm         ::= 'case' Pattern ('when' Expression)? (':' | '->') Expression | 'default' (':' | '->') Expression
                      (* '->' is the legacy ADR-0009 form. Per ADR-0074 (#714) ':' is the preferred separator; the legacy '->' form is still accepted but emits warning GS0302. *)
                      (* The optional 'when' guard (#991) selects the arm only when the pattern matches AND the guard is true; 'when' is a contextual keyword. *)
Pattern           ::= OrPattern
                      (* Combinators (#992): 'not' binds tightest, then 'and', then 'or'; 'and'/'or'/'not' are contextual keywords. *)
OrPattern         ::= AndPattern ('or' AndPattern)*
AndPattern        ::= UnaryPattern ('and' UnaryPattern)*
UnaryPattern      ::= 'not' UnaryPattern | PrimaryPattern
PrimaryPattern    ::= '(' Pattern ')'
                    | '[' Pattern (',' Pattern)* ']'
                    | '{' identifier ':' Pattern (',' identifier ':' Pattern)* '}'
                    | identifier 'is' TypeClause
                    | '_'                                  (* discard: identifier '_' not followed by '(' or '.' *)
                    | ('<' | '<=' | '>' | '>=' | '==' | '!=') Expression
                    | Expression

TryStmt           ::= 'try' Block CatchClause* FinallyClause?
CatchClause       ::= 'catch' '(' identifier TypeClause? ')' Block
FinallyClause     ::= 'finally' Block
ThrowStmt         ::= 'throw' Expression
UsingStmt         ::= 'using' VariableDecl
AwaitUsingStmt    ::= 'await' 'using' VariableDecl
DeferStmt         ::= 'defer' Expression
GoStmt            ::= 'go' Expression
ScopeStmt         ::= 'scope' Block
AwaitForRangeStmt ::= 'await' 'for' identifier 'in' Expression Block
SelectStmt        ::= 'select' '{' SelectCase* '}'
SelectCase        ::= 'default' Block
                    | 'case' '<-' Expression Block
                    | 'case' 'let' identifier '=' '<-' Expression Block
                    | 'case' Expression '<-' Expression Block
ChannelSendStmt   ::= Expression '<-' Expression

Expression        ::= Assignment
Assignment        ::= identifier '=' Assignment
                    | identifier CompoundAssign Assignment
                    | identifier '[' Expression ']' '=' Assignment
                    | identifier '.' identifier '=' Assignment
                    | PostfixExpression '[' Expression ']' ('=' | CompoundAssign) Assignment
                    | PostfixExpression '.' identifier '=' Assignment
                    | '*' PrefixExpression '=' Assignment                (* indirect (pointer) assignment, ADR-0060 *)
                    | (identifier | PostfixExpression) ('+=' | '-=') Assignment   (* event subscribe / unsubscribe *)
                    | ConditionalExpression
ConditionalExpression ::= RangeExpression ('?' Assignment ':' Assignment)?   (* ternary, ADR-0062 *)
RangeExpression   ::= NullCoalescingExpression? '..' ('^'? NullCoalescingExpression)? | NullCoalescingExpression   (* standalone System.Range value, issue #1038; `..` binds looser than all binary operators. A leading '^' is rejected (GS0410); a '^' upper bound is a from-end marker. Suppressed inside an index bound (IndexArgument owns '..'); re-enabled inside parens/argument lists. *)
NullCoalescingExpression ::= WithExpression ('??' NullCoalescingExpression)?  (* right-assoc null-coalescing, Issue #941 *)
WithExpression    ::= BinaryExpression ('with' '{' FieldEqualsList? '}')*    (* non-destructive record update *)
CompoundAssign    ::= '+=' | '-=' | '*=' | '/=' | '%=' | '^=' | '&=' | '|=' | '&^=' | '<<=' | '>>=' | '??='
BinaryExpression  ::= PrefixExpression BinaryTail*
BinaryTail        ::= BinaryOperator PrefixExpression
                    | ('is' | 'as' | '!' 'is') TypeClause                (* type test / cast, ADR-0069 *)
BinaryOperator    ::= '*' | '/' | '%' | '<<' | '>>' | '&' | '&^'
                    | '+' | '-' | '|' | '^'
                    | '==' | '!=' | '<' | '<=' | '>' | '>='
                    | '&&'
                    | '||'
PrefixExpression  ::= ('+' | '-' | '!' | '^' | '*' | '&' | '<-' | 'await') PrefixExpression | PostfixExpression
PostfixExpression ::= PrimaryExpression PostfixOp*
PostfixOp         ::= '!!' | ('.' | '?.') NameOrCall | ('[' | '?[') IndexArgument ']'
IndexArgument     ::= IndexBound | IndexBound? '..' IndexBound?   (* range/slice form, issue #1016; from-end via issue #1022 *)
IndexBound        ::= '^'? Expression                            (* leading '^' marks a from-end index, issue #1022 *)
NameOrCall        ::= identifier | Call | GenericCall
PrimaryExpression ::= Literal | identifier
                    | Call | GenericCall | NullableTypeCall | ObjectCreation
                    | CollectionInitializer
                    | StructLiteral | GenericStructLiteral | ArrayLiteral | MapLiteral
                    | FunctionLiteral | LambdaExpression
                    | SwitchExpr | IfExpression
                    | '(' Expression ')' | TupleLiteral
                    | MakeChannel | TypeOf | NameOf | DefaultExpression | BaseInterfaceCall
                    | ThrowExpr                                          (* throw-expression, issue #1018 *)
Literal           ::= Number | String | InterpolatedString | 'true' | 'false' | 'nil' | char
InterpolatedString ::= '"' ( InterpolationText | '$$' | '$' identifier | InterpolationHole )* '"'
InterpolationHole ::= '${' Expression ( ',' SignedInteger )? ( ':' FormatText )? '}'
Call              ::= identifier '(' Arguments? ')' TrailingLambda?
GenericCall       ::= identifier TypeArgList '(' Arguments? ')' TrailingLambda?
NullableTypeCall  ::= identifier '?' '(' Arguments? ')' TrailingLambda?   (* nullable-type construction, issue #663 *)
ObjectCreation    ::= (Call | GenericCall) '{' ObjectInitList? '}'        (* Foo() { F = v, ... }, issue #522 *)
ObjectInitList    ::= identifier '=' Expression (',' identifier '=' Expression)* ','?
CollectionInitializer ::= CollectionTarget '{' CollectionElementList? '}'  (* List[T]{ ... }, ADR-0117, issue #479 *)
CollectionTarget  ::= GenericCall | Call                                  (* List[T], Dictionary[K,V](cmp), ... *)
                    | identifier TypeArgList                              (* List[T]  — synthesizes a zero-arg ctor *)
CollectionElementList ::= CollectionElement (',' CollectionElement)* ','?
CollectionElement ::= Expression                                          (* bare:    1            → Add(1)        *)
                    | Expression ':' Expression                          (* keyed:   "a": 1       → Add("a", 1)   *)
                    | '[' Expression ']' '=' Expression                  (* indexed: ["a"] = 1    → this["a"] = 1 *)
StructLiteral     ::= identifier '{' FieldInitList? '}'
GenericStructLiteral ::= identifier TypeArgList '{' FieldInitList? '}'
FieldInitList     ::= identifier ':' Expression (',' identifier ':' Expression)* ','?
FieldEqualsList   ::= identifier '=' Expression (',' identifier '=' Expression)* ','?
ArrayLiteral      ::= '[' Number? ']' identifier '{' ExpressionList? '}'
MapLiteral        ::= 'map' '[' TypeClause ',' TypeClause ']' '{' MapEntryList? '}'
                    | 'map' '[' TypeClause ']' TypeClause '{' MapEntryList? '}'    (* legacy; GS0366 *)
MapEntry          ::= Expression ':' Expression
FunctionLiteral   ::= 'async'? 'func' '(' Parameters? ')' TypeClause? Block
LambdaExpression  ::= 'async'? '(' LambdaParameters? ')' '->' ( Expression | Block )
LambdaParameters  ::= LambdaParameter (',' LambdaParameter)*
LambdaParameter   ::= Annotation* 'scoped'? ('ref' | 'out' | 'in')? identifier '...'? TypeClause? ('=' Expression)?
TrailingLambda    ::= FunctionLiteral
MakeChannel       ::= 'make' '(' 'chan' TypeClause (',' Expression)? ')'
TypeOf            ::= 'typeof' '(' TypeClause ')'
NameOf            ::= 'nameof' '(' Expression ')'
DefaultExpression ::= 'default' ('(' TypeClause ')')?                     (* ADR-0100 *)
BaseInterfaceCall ::= 'base' '[' TypeClause ']' '.' identifier TypeArgList? '(' Arguments? ')'   (* explicit-base interface call, ADR-0091 *)
IfExpression      ::= 'if' Expression Block ('else' (IfExpression | Block))?   (* if-as-expression, issue #669 *)
TupleLiteral      ::= '(' Expression ',' Expression (',' Expression)* ')'
Arguments         ::= Argument (',' Argument)*
Argument          ::= identifier (':' | '=') (RefArgument | Expression)   (* named argument; '=' separator is deprecated, GS0315 *)
                    | RefArgument
                    | Expression
RefArgument       ::= ('ref' | 'in') (identifier | '(' Expression ')')
                    | 'out' (('var' | 'let') identifier TypeClause? | '_' TypeClause? | identifier | '(' Expression ')')
```
