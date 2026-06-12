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
:  :=  ;  ,  .  ...  ^  ^=  &  &&  &=  &^  &^=  |  |=  ||
=  ==  !  !=  !!  ?  ?.  ?[  ?:  ??=  <  <=  <-  ->  <<  <<=  >  >=  >>  >>=  @
```

### Identifiers

Identifiers start with a Unicode letter or `_` and continue with Unicode letters, Unicode digits, or `_`. The implementation uses .NET `char.IsLetter` and `char.IsLetterOrDigit`, so names such as `café`, `π`, and `_value2` are valid. Identifiers represented only by surrogate pairs are not currently accepted as identifier characters.

```ebnf
identifier = letter { letter | unicode_digit } .
letter     = unicode_letter | "_" .
```

### Keywords

The reserved keywords are:

```text
as async await break case catch chan class const continue default defer do else enum false fallthrough finally for func go goto guard if import interface internal is let map nil open operator override package private public range return scope sealed select sequence struct switch throw true try type using var while
```

Several words are contextual rather than reserved. `record`, `data`, `inline`, `prop`, `event`, `shared`, `init`, `get`, `set`, `add`, `remove`, `raise`, `in`, `out`, `yield`, `with`, `typeof`, `nameof`, and `make` retain identifier status except in the grammar contexts described below.

### Operators and punctuation

Compound assignment recognizes `+=`, `-=`, `*=`, `/=`, `%=`, `^=`, `&=`, `|=`, `&^=`, `<<=`, and `>>=`. The parser rewrites these as assignment with the corresponding binary operator. `++` and `--` are statement forms on identifiers. The null-coalescing compound assignment `??=` (ADR-0072) writes the right-hand side into the left only when the lvalue currently reads as nil; see [Null-coalescing compound assignment](#null-coalescing-compound-assignment--adr-0072) under *Statements*. `@` begins annotations on declarations.

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

`true` and `false` are boolean literals. `nil` is the null literal. `null` is not a keyword or literal in G#.

## Constants and variables

G# has `const`, `let`, and `var` declarations. A constant or `let` binding requires an initializer. A `var` binding may either have an initializer or name a type for a zero/default value.

```ebnf
VariableDecl = ( "const" | "let" | "var" ) identifier TypeClause? "=" Expression
             | "var" identifier TypeClause
             | "let" "(" identifier { "," identifier } ")" "=" Expression
             | "let" "{" identifier "=" identifier { "," identifier "=" identifier } "}" "=" Expression .
ShortVarDecl = identifier ":=" Expression .
```

`let` communicates immutability of the binding. `var` introduces a mutable variable. `const` is for compile-time constants. Tuple deconstruction and named deconstruction use `let` forms. Multi-target assignment is statement syntax and is limited to identifier target lists today.

## Types

### Predeclared types

The predeclared primitive and special type names are `bool`, `uint8`, `int8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `nint`, `nuint`, `float32`, `float64`, `decimal`, `char`, `string`, `object`, `void`, and the special literal type `nil`. Width-bearing integer names are canonical; older aliases such as `int`, `uint`, `long`, and `byte` are not built-in G# primitive names.

### Boolean types

`bool` has values `true` and `false`. Logical operators are `!`, `&&`, and `||`. Bitwise-style boolean operators `&`, `|`, and `^` are also defined.

### Numeric types

Integral types are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `nint`, and `nuint`. Floating and decimal types are `float32`, `float64`, and `decimal`. Operators are defined per primitive type rather than by implicit cross-type promotion. Widening numeric conversions follow the implemented conversion lattice; other numeric primitive pairs require explicit conversion.

### String and character types

`string` is the CLR `System.String` type. It supports concatenation with `+` and equality with `==` and `!=`. `char` is the CLR `System.Char` type and supports comparison.

### Object and nil

`object` is the universal upper bound. Values backed by CLR types and user value types can implicitly convert or box to `object`; explicit conversions can unbox to CLR value types. Nullable types are written by appending `?` to a type clause. `nil` converts implicitly to nullable types but not to non-nullable types. Postfix `!!` asserts non-null and `?:` is null coalescing.

### Arrays and slices

Fixed arrays are written `[N]T`, and slices are written `[]T`. Array and slice composite literals use the same bracketed prefix with an element type identifier:

```gsharp
let xs = []int32{1, 2, 3}
let ys = [3]int32{1, 2, 3}
```

Slices are backed by CLR arrays. `len` and `cap` observe array length, and `append` allocates and copies into a new array in the current implementation.

### Maps

Maps are written `map[K]V` and are backed by `Dictionary<K,V>` in the implementation. Map literals use key-value entries, indexing reads values, and indexed assignment updates entries.

```gsharp
let counts = map[string]int32{"g": 1, "sharp": 2}
```

### Sequences

`sequence[T]` is the sequence type and projects to `IEnumerable<T>`. A function returning `sequence[T]` can use `yield` to produce values. `async sequence[T]` projects to asynchronous enumeration. There is no dedicated sequence literal syntax today; use arrays, slices, iterator functions, or imported CLR sequence producers.

### Channels

Channels are written `chan T`. A channel value is created with `make(chan T)` or `make(chan T, capacity)`. Prefix receive is `<-ch`; send statements are `ch <- value`; `select` multiplexes receive and send cases. Channels are backed by `System.Threading.Channels`.

```gsharp title="samples/Channels.gs"
package GSharp.Samples.Channels

import System

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

### Function types

Function types are written `(T1, T2) -> R` (ADR-0075) — fully-parenthesized parameter type list, a single `->` arrow, then a return type clause. A void-returning function uses `void` as the return type: `(T1, T2) -> void`. Multi-return shapes use a tuple return type: `() -> (T1, T2)`. Async function type clauses are written `async (T) -> R`; they represent functions returning `Task<R>` or `Task` for no result. G# function values can convert to compatible CLR delegate types. The legacy `func(T1, T2) R` and `async func(T) R` type-clause spellings continue to parse for one release; each occurrence emits a `GS0303` deprecation warning.

### Structs, classes, records, and inline value classes

Type declarations introduce aggregates with `type`. Structs are value-like. Classes are reference-like and can have primary constructors, explicit `init` constructors, base classes, interfaces, fields, methods, properties, events, and `shared` static members. Plain classes are sealed for inheritance unless marked `open`; overriding requires `override` and a compatible open base method.

`data struct` synthesizes structural ergonomics such as equality and copy/update support. `record` is currently a parser-level alias for `data struct`. `inline struct` is the inline value class form and must have exactly one field.

```gsharp title="samples/DataStruct.gs"
package GSharp.Example.DataStruct

import System

type Point data struct {
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

Interfaces contain method, property, and event signatures. Although design records discuss default interface members, the current parser diagnoses interface method bodies and the symbol model treats interfaces as signatures only. Classes can implement interfaces and values can upcast to implemented interfaces.

### Enums

Enums are declared with `type Name enum { ... }`. They may not be generic and must contain at least one member. Equality is supported, and switch exhaustiveness diagnostics understand enum members.

### Generics

Generic declarations and instantiations use brackets rather than angle brackets. Type parameters can have variance markers `in` and `out` and a named constraint.

```gsharp
func Identity[T any](value T) T {
    return value
}

let x = Identity[int32](42)
```

The implementation emits metadata specs for generic types and methods, but open or partially constructed shapes containing type parameters are erased to `object` in some emit paths under the current type-erased generic model. Generic method inference is implemented for supported cases.

### Type syntax

```ebnf
TypeClause = identifier TypeArgList? "?"?
           | "[" number? "]" identifier "?"?
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

CLR `ref struct` types such as `Span[T]` and `ReadOnlySpan[T]` are consumable as stack-only values (ADR-0056): they are indexable (`s[i]`), ref-returning members auto-dereference in rvalue position, a `[]T` slice converts implicitly to a span, and a user `type X ref struct { … }` may embed a closed generic value-type field. Stack-escape violations are reported as `GS0219`; writing through a `ReadOnlySpan[T]` element is `GS0226`. The full ref-safe-to-escape analysis is deferred (issue #376).

## Declarations and scope

### Packages and imports

A package declaration names the package for the compilation unit. Imports bring packages, CLR namespaces, or aliases into scope. The compiler can add an implicit `System` import by default; `/noimplicitimports` disables it.

```ebnf
CompilationUnit = PackageDecl? ImportDecl* Member* EOF .
PackageDecl     = "package" identifier { "." identifier } .
ImportDecl      = "import" ( identifier "=" )? identifier { "." identifier } .
```

### Top-level declarations

Top-level members are functions, type declarations, variable declarations, or top-level statements. Mixing explicit `Main` and top-level statements is diagnosed. Accessibility modifiers are `public`, `internal`, and `private`; defaults depend on declaration context.

```ebnf
Member        = Annotation* Accessibility? ( Async? FunctionDecl | TypeDecl | VariableDecl | GlobalStatement ) .
Accessibility = "public" | "internal" | "private" .
Annotation   = "@" ( AnnotationTarget ":" )? identifier { "." identifier } ( "(" Arguments? ")" )? .
```

### Functions and methods

Functions use `func`. Receiver clauses declare receiver-style methods and extension functions. Operator overloads use `operator` followed by the operator token and map to CLR operator names downstream. Parameters may carry a ref-kind modifier (`ref`, `out`, or `in`, ADR-0060) and may declare a compile-time-constant default value to become optional (ADR-0063). User functions may be overloaded as long as overloads differ by parameter types, arity, or ref-kinds; two declarations that differ only in return type are rejected as `GS0264`.

```ebnf
FunctionDecl      = "func" ReceiverClause? ( identifier | OperatorName ) TypeParamList? "(" Parameters? ")" RefReturnClause? Block .
AsyncFunctionDecl = "async" FunctionDecl .
ReceiverClause    = "(" Parameter ")" .
OperatorName      = "operator" OperatorToken .
TypeParamList     = "[" TypeParameter { "," TypeParameter } "]" .
TypeParameter     = ( "in" | "out" )? identifier ConstraintName? .
Parameters        = Parameter { "," Parameter } .
Parameter         = Annotation* ParameterModifier? identifier "..."? TypeClause ( "=" ConstantExpression )? .
ParameterModifier = "ref" | "out" | "in" | "scoped" .
RefReturnClause   = "ref"? TypeClause .
```

A function declared `func f(...) ref T` returns a managed pointer and pairs with the `return ref <lvalue>` statement form (diagnostics `GS0248`–`GS0255`). The `scoped` modifier on a `ref struct` / managed-pointer parameter constrains the value from escaping the call (enforced by the by-ref-like rules in `GS9004` / `GS9006`).

### Type declarations

```ebnf
TypeDecl          = "type" identifier TypeParamList? ( TypeAliasTail | DelegateAliasTail | StructDeclTail | ClassDeclTail | EnumDeclTail | InterfaceDeclTail ) .
TypeAliasTail     = "=" identifier .
DelegateAliasTail = "=" "delegate" "func" "(" Parameters? ")" TypeClause? .
StructDeclTail    = Data? Inline? Open? Ref? "struct" PrimaryCtor? StructBody .
ClassDeclTail     = Open? "class" PrimaryCtor? BaseClause? StructBody .
RecordDeclTail    = ( "record" | Data? "record" ) StructBody .
EnumDeclTail      = "enum" "{" EnumMemberList? "}" .
InterfaceDeclTail = Sealed? "interface" InterfaceBody .
PrimaryCtor       = "(" Parameters? ")" .
BaseClause        = ":" QualifiedTypeName ( "(" Arguments? ")" )? { "," QualifiedTypeName } .
```

A `DelegateAliasTail` declares a real CLR `MulticastDelegate`-derived named delegate type (ADR-0059), so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types. Diagnostics `GS0233`–`GS0234` cover malformed declarations.

### Members

```ebnf
StructBody       = "{" StructMember* "}" .
StructMember     = Annotation* Accessibility? ( OpenOrOverride* ( MethodDecl | PropertyDecl | EventDecl | ConstructorDecl ) | SharedBlock | FieldDecl ) .
OpenOrOverride   = "open" | "override" .
ConstructorDecl  = "init" "(" Parameters? ")" ( ":" identifier "(" Arguments? ")" )? Block .
SharedBlock      = "shared" "{" SharedMember* "}" .
SharedMember     = Accessibility? ( MethodDecl | PropertyDecl | EventDecl | FieldDecl ) .
FieldDecl        = Accessibility? identifier TypeClause ( "=" Expression )? .
PropertyDecl     = "prop" identifier TypeClause PropertyBody? .
PropertyAccessor = ( "get" | "set" ( "(" identifier ")" )? ) ( Block | ";" )? .
EventDecl        = "event" identifier TypeClause EventBody? .
EventAccessor    = ( "add" | "remove" | "raise" ) ( Block | ";" )? .
InterfaceBody    = "{" ( FunctionSignature | PropertyDecl | EventDecl )* "}" .
```

## Expressions

### Precedence

Unary operators bind tighter than binary operators. Binary operators are left-associative; higher precedence binds tighter.

| Precedence | Operators | Meaning |
| --- | --- | --- |
| 7 | `+`, `-`, `!`, `^`, `*`, `&`, `<-`, `await` | unary |
| 6 | `*`, `/`, `%`, `<<`, `>>`, `&`, `&^` | multiplicative, shifts, bitwise and, bit clear |
| 5 | `+`, `-`, `\|`, `^` | additive, bitwise or, xor |
| 4 | `==`, `!=`, `<`, `<=`, `>`, `>=`, `is`, `as` | equality, comparison, type test, safe cast |
| 3 | `&&` | logical and |
| 2 | `\|\|`, `?:` | logical or and null coalescing |
| 1 | `?` … `:` … | conditional (ternary, right-associative) |

The conditional expression `cond ? whenTrue : whenFalse` (ADR-0062) requires `cond` to be `bool` and the two branches to share a common type. Mismatched branches report `GS0263`. The narrow ADR-0061 form `ref cond ? lhs : rhs` (and its `out` / `in` siblings) survives as a payload to a ref-kind argument; diagnostics `GS0260`–`GS0262` apply there.

### Type-test and safe-cast operators

`expr is T` evaluates to `bool` — `true` when the runtime type of `expr` is assignable to `T`, `false` otherwise (including when `expr` is `nil`). `expr as T` performs a safe downcast: it returns the value typed as `T` when the cast succeeds, or `nil` when it fails. For reference types the result type is `T`; for value types, the target must be written as the nullable form `T?` (e.g. `x as int32?`) and the result type is `T?`. Using `as` with a non-nullable value type target produces diagnostic `GS0269`. Both operators use the CLR `isinst` instruction and sit at precedence level 4 (same as equality and comparison), so `x is String == true` and `a is T && b is U` parse as expected without extra parentheses. The existing pattern-level `identifier is Type` syntax inside `switch`/`case` arms is unaffected.

A successful `is` (or `!is`) test against a local, parameter, or read-only top-level `let` flow-narrows the receiver to the tested type for the rest of the enclosing flow region — see *Smart casts (flow narrowing)* below.

Postfix `!!`, member access `.`, null-conditional access `?.`, null-conditional indexing `?[`, indexing, calls, and generic instantiation are parsed greedily on primary expressions. This applies to **any** primary, including a parenthesized expression — for example `(a + b).GetType()`, `(nums)[0]`, and `("s").Length` are all valid. The sole exception is a bare numeric literal: `42.Member` is not accepted because it is ambiguous with float-literal lexing; wrap it as `(42).Member` instead (see ADR-0054).

### Primary expressions and calls

Primary expressions include literals, identifiers, calls, generic calls, struct literals, array or slice literals, map literals, function literals, switch expressions, if expressions (ADR-0064), tuple literals, `make(chan ...)`, `typeof(...)`, and `nameof(...)`. Calls accept positional, named, and ref-kind-prefixed arguments:

- **Named arguments** — `Foo(timeout: 30, retries: 3)` (or the legacy `Foo(timeout = 30)` shape) for free functions, user methods, user constructors, user extension functions, imported CLR methods and constructors, imported extension methods, and inherited CLR instance methods (including delegate `Invoke`). Indirect calls through a function-typed or delegate-typed variable, and variadic call sites, do not accept named arguments because the call target does not preserve parameter names. Diagnostics `GS0244`–`GS0247` cover ordering, duplicates, and unknown names.
- **Ref-kind arguments** — `f(ref x)`, `f(out var n)`, `f(in z)` (ADR-0060). The call-site modifier must match the parameter's declared kind (`GS0235`); `in` requires an explicit `in` at the call site to prevent silent spilling (`GS0242`).

Generic instantiation uses brackets and bounded lookahead to distinguish type arguments from indexing. Examples include `Id[int32](1)` and `Box[string]{Value: "x"}`.

Function literals use `func` or `async func`. A trailing lambda can appear after an explicit call close-paren and is desugared into the final argument. ADR-0074 (issue #714) also introduces a dedicated arrow-lambda expression form: `(p1 T1, p2 T2) -> body`. The parameter list is always parenthesized — there is no bare-identifier shorthand. The body is either a single expression or a brace-delimited block expression whose trailing expression is the lambda value. Arrow lambdas share the function-literal capture, lowering, and emit pipeline (closures, `ldftn`/`newobj`, delegate construction).

```ebnf
FunctionLiteral = "func" "(" Parameters? ")" TypeClause? Block
                | "async" "func" "(" Parameters? ")" TypeClause? Block .
TrailingLambda  = FunctionLiteral .
LambdaExpression = "(" Parameters? ")" "->" ( Expression | Block ) .
```

### Accessor chains

Member access and indexing chain after primaries. `a.b`, `a?.b`, `a[i]`, `a?[i]`, `a.b(c)`, and generic call access forms are valid where the binder can resolve the target. Chains also apply to parenthesized and literal receivers — `(a + b).GetType()`, `(nums)[0]`, `("s").Length`, and `switch v { … }.ToString()` — with one exception: a bare numeric literal does not chain (`42.Member` is unsupported; write `(42).Member`). Assignment permits identifiers, indexed targets, field/property targets, and event `+=` or `-=` on accessors. Null-conditional forms (`?.`, `?[]`) are not allowed on the left-hand side of an assignment (see ADR-0073, diagnostic GS0301).

### Composite literals

Struct literals use `TypeName{Field: value}`. Data structs also support copy/update with `expr with { Field = value }`. Array and slice literals use `[N]T{...}` or `[]T{...}`. Map literals use `map[K]V{key: value}`.

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

### Lambda expressions (ADR-0074)

`->` introduces a lambda expression with a parenthesized parameter list. There is no bare-identifier shorthand: `(x int32) -> x + 1` is a lambda, `x -> x + 1` is not. The body is either a single expression or a brace-delimited block whose trailing expression supplies the lambda value. Lambdas may capture outer locals; the closure machinery is shared with `func` literals.

```gsharp
let inc = (x int32) -> x + 1
let add = (a int32, b int32) -> a + b
let triple = (x int32) -> {
    let doubled = x * 2
    doubled + x
}
```

Parameter type inference and a dedicated function-type syntax (`(T) -> R`) are tracked separately — see issues #715 and #716. Today every lambda parameter must carry an explicit type clause.

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
- `throw` is a statement in G# (the switch expression does not accept `throw` as an arm value either). To exit on the error path of an if-expression, place a `throw` statement in the prefix of the block and supply a tail expression of the chosen result type; the tail is unreachable at runtime but satisfies the binder's typing requirement. This matches the switch-expression treatment.

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
                  | BinaryExpression .
BinaryExpression  = PrefixExpression { BinaryOperator PrefixExpression } .
PrefixExpression  = ( "+" | "-" | "!" | "^" | "*" | "&" | "<-" | "await" ) PrefixExpression | PostfixExpression .
PostfixExpression = PrimaryExpression { "!!" } { ( "." | "?." ) NameOrCall | ( "[" | "?[" ) Expression "]" } ( "with" "{" FieldEqualsList? "}" )? .
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
Statement = Block | Annotation* VariableDecl | IfStmt | IfLetStmt | GuardLetStmt | ForStmt | WhileStmt | DoWhileStmt | LabeledLoopStmt | BreakStmt | ContinueStmt | ReturnStmt | YieldStmt | SwitchStmt | TryStmt | ThrowStmt | UsingStmt | DeferStmt | GoStmt | ScopeStmt | AwaitForRangeStmt | SelectStmt | MultiAssignmentStmt | NullCoalescingAssignmentStmt | ShortVarDecl | IncDecStmt | ChannelSendStmt | ExpressionStmt .
```

### Assignment and variable statements

Short declaration is `name := expr`. Multi-target assignment supports `a, b = x, y` and `a, b := x, y` for identifier target lists. Increment and decrement are statements, not expressions.

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
SwitchCase = "case" Pattern Block | "default" Block .
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

G# has `for`, `for in`, `for range`, `while`, and `do`-`while` forms.

```ebnf
ForStmt = "for" Statement
        | "for" Expression Statement
        | "for" SimpleStmt? ";" Expression? ";" SimpleStmt? Statement
        | "for" identifier ( "," identifier )? ( ":=" "range" | "in" ) Expression Statement
        | "for" identifier ":=" Expression "..." Expression Statement .

WhileStmt    = "while" Expression Statement .
DoWhileStmt  = "do" Block "while" Expression .
```

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

`go expr` starts a concurrent call; binding requires the operand to be a call. `scope { ... }` is structured concurrency and joins registered child tasks at scope exit. Channel receive is a prefix expression `<-ch`; channel send is a statement `ch <- value`. `select` supports default, receive-discard, receive-bind, and send cases.

```ebnf
GoStmt     = "go" Expression .
ScopeStmt  = "scope" Block .
SelectStmt = "select" "{" SelectCase* "}" .
SelectCase = "default" Block
           | "case" "<-" Expression Block
           | "case" identifier ":=" "<-" Expression Block
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

### Await and async iteration

`await expr` is a prefix expression and must appear in an async context with an awaitable operand. `await for` iterates asynchronous sequences.

```ebnf
AwaitForRangeStmt = "await" "for" identifier ( "in" | ":=" "range" ) Expression Block .
```

## Concurrency

`go` launches concurrent function calls. In the interpreter, `go` uses `Task.Run`; outside `scope`, exceptions can be unobserved, while inside `scope` child tasks are registered and joined when the scope exits. The interpreter serializes some evaluation through locks, so it is a correctness implementation rather than a performance model. The emit path supports channels, `go`, `scope`, and `select` through lowering and CLR primitives.

Channels are typed, can be buffered, and support `close`, send, receive, and `select`. Receiving from a closed channel yields the element default value in the implemented channel path, as shown by the `Channels` sample.

## Async and iterators

`async func` declarations and literals are supported. The emit path lowers async methods and lambdas to state machines, including exception handler rewriting, spill management, and capture analysis. The interpreter blocks on awaiters and `ValueTask` results.

Iterator functions return `sequence[T]` and contain `yield`. Async sequences use `async sequence[T]` and `await for`. The emit path has synchronous and asynchronous iterator state-machine rewriters; the interpreter executes async iteration by blocking.

## CLR interop semantics

G# imports can resolve CLR namespaces and metadata references. CLR primitive types map to G# built-ins when possible; other CLR types are represented as imported types. The binder and evaluator support imported constructors, static and instance methods, fields, properties, indexers, events, delegates, method groups, operator overloads, and conversion operators. G# function values can convert to compatible CLR delegates such as `Action`, `Func`, named delegates, and `Predicate`, and can widen to `System.Delegate` or `System.MulticastDelegate`.

Attributes use `@Name(...)` and optional use-site targets such as `@field:`, `@param:`, and `@return:`. The current implementation recognizes attributes, but user P/Invoke or extern declarations are not supported.

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
CompilationUnit   ::= PackageDecl? ImportDecl* Member* EOF
PackageDecl       ::= 'package' identifier ('.' identifier)*
ImportDecl        ::= 'import' (identifier '=')? identifier ('.' identifier)*
Member            ::= Annotation* Accessibility? (Async? FunctionDecl | TypeDecl | VariableDecl | GlobalStatement)
Accessibility     ::= 'public' | 'internal' | 'private'
Annotation        ::= '@' (AnnotationTarget ':')? identifier ('.' identifier)* ('(' Arguments? ')')?
AnnotationTarget  ::= 'field' | 'param' | 'return' | 'type' | 'method' | 'property' | 'event' | 'module' | 'assembly' | 'genericparam'

FunctionDecl      ::= 'func' ReceiverClause? (identifier | OperatorName) TypeParamList? '(' Parameters? ')' TypeClause? Block
AsyncFunctionDecl ::= 'async' FunctionDecl
ReceiverClause    ::= '(' Parameter ')'
OperatorName      ::= 'operator' OperatorToken
TypeParamList     ::= '[' TypeParameter (',' TypeParameter)* ']'
TypeParameter     ::= ('in' | 'out')? identifier ConstraintName?
ConstraintName    ::= identifier
Parameters        ::= Parameter (',' Parameter)*
Parameter         ::= Annotation* identifier '...'? TypeClause

TypeDecl          ::= 'type' identifier TypeParamList? (TypeAliasTail | StructDeclTail | ClassDeclTail | EnumDeclTail | InterfaceDeclTail)
TypeAliasTail     ::= '=' identifier
StructDeclTail    ::= Data? Inline? Open? 'struct' PrimaryCtor? StructBody
ClassDeclTail     ::= Open? 'class' PrimaryCtor? BaseClause? StructBody
RecordDeclTail    ::= ('record' | Data? 'record') StructBody
EnumDeclTail      ::= 'enum' '{' EnumMemberList? '}'
InterfaceDeclTail ::= Sealed? 'interface' InterfaceBody
Data              ::= contextual 'data'
Inline            ::= contextual 'inline'
Open              ::= 'open'
Sealed            ::= 'sealed'
PrimaryCtor       ::= '(' Parameters? ')'
BaseClause        ::= ':' QualifiedTypeName ('(' Arguments? ')')? (',' QualifiedTypeName)*
EnumMemberList    ::= Annotation* identifier (',' Annotation* identifier)* ','?

StructBody        ::= '{' StructMember* '}'
StructMember      ::= Annotation* Accessibility? (OpenOrOverride* (MethodDecl | PropertyDecl | EventDecl | ConstructorDecl) | SharedBlock | FieldDecl)
OpenOrOverride    ::= 'open' | 'override'
ConstructorDecl   ::= contextual 'init' '(' Parameters? ')' (':' identifier '(' Arguments? ')')? Block
SharedBlock       ::= contextual 'shared' '{' SharedMember* '}'
SharedMember      ::= Accessibility? (MethodDecl | PropertyDecl | EventDecl | FieldDecl)
MethodDecl        ::= FunctionDecl
FieldDecl         ::= Accessibility? identifier TypeClause ('=' Expression)?
PropertyDecl      ::= contextual 'prop' identifier TypeClause (PropertyBody)?
PropertyBody      ::= '{' PropertyAccessor* '}'
PropertyAccessor  ::= ('get' | 'set' ('(' identifier ')')?) (Block | ';')?
EventDecl         ::= contextual 'event' identifier TypeClause (EventBody)?
EventBody         ::= '{' EventAccessor* '}'
EventAccessor     ::= ('add' | 'remove' | 'raise') (Block | ';')?
InterfaceBody     ::= '{' (FunctionSignature | PropertyDecl | EventDecl)* '}'
FunctionSignature ::= 'func' identifier '(' Parameters? ')' TypeClause? Block?

TypeClause        ::= identifier TypeArgList? '?'?
                    | '[' Number? ']' identifier '?'?
                    | '(' TypeClause (',' TypeClause)+ ')' '?'?
                    | '(' TypeClauseList? ')' '->' TypeClause '?'?
                    | 'async' '(' TypeClauseList? ')' '->' TypeClause '?'?
                    | 'map' '[' TypeClause ']' TypeClause '?'?
                    | 'chan' TypeClause '?'?
                    | 'sequence' '[' TypeClause ']' '?'?
                    | 'async' 'sequence' '[' TypeClause ']' '?'?
                    | 'func' '(' TypeClauseList? ')' TypeClause? '?'?            (* deprecated; GS0303 *)
                    | 'async' 'func' '(' TypeClauseList? ')' TypeClause? '?'?    (* deprecated; GS0303 *)
                    | '*' TypeClause '?'?
TypeArgList       ::= '[' TypeClause (',' TypeClause)* ']'
TypeClauseList    ::= TypeClause (',' TypeClause)*

Block             ::= '{' Statement* '}'
Statement         ::= Block
                    | Annotation* VariableDecl
                    | IfStmt | IfLetStmt | GuardLetStmt | ForStmt | WhileStmt | DoWhileStmt | LabeledLoopStmt | BreakStmt | ContinueStmt | ReturnStmt | YieldStmt
                    | SwitchStmt | TryStmt | ThrowStmt | UsingStmt | DeferStmt | GoStmt | ScopeStmt
                    | AwaitForRangeStmt | SelectStmt | MultiAssignmentStmt | ShortVarDecl
                    | IncDecStmt | ChannelSendStmt | ExpressionStmt
VariableDecl      ::= ('const' | 'let' | 'var') identifier TypeClause? '=' Expression
                    | 'var' identifier TypeClause
                    | 'let' '(' identifier (',' identifier)* ')' '=' Expression
                    | 'let' '{' identifier '=' identifier (',' identifier '=' identifier)* '}' '=' Expression
ShortVarDecl      ::= identifier ':=' Expression
MultiAssignment   ::= identifier (',' identifier)+ ('=' | ':=') Expression (',' Expression)*
IncDecStmt        ::= identifier ('++' | '--')

IfStmt            ::= 'if' (SimpleStmt ';')? Expression Statement ('else' Statement)?
IfLetStmt         ::= 'if' LetBindingList Statement ('else' Statement)?
GuardLetStmt      ::= 'guard' LetBindingList 'else' Block
LetBindingList    ::= LetBindingClause (',' LetBindingClause)*
LetBindingClause  ::= 'let' identifier TypeClause? '=' Expression
ForStmt           ::= 'for' Statement
                    | 'for' Expression Statement
                    | 'for' SimpleStmt? ';' Expression? ';' SimpleStmt? Statement
                    | 'for' identifier (',' identifier)? (':=' 'range' | contextual 'in') Expression Statement
                    | 'for' identifier ':=' Expression '...' Expression Statement
WhileStmt         ::= 'while' Expression Statement
DoWhileStmt       ::= 'do' Block 'while' Expression
LabeledLoopStmt   ::= identifier ':' (ForStmt | WhileStmt | DoWhileStmt)
SimpleStmt        ::= ShortVarDecl | IncDecStmt | ExpressionStmt
BreakStmt         ::= 'break' identifier?
ContinueStmt      ::= 'continue' identifier?
ReturnStmt        ::= 'return' Expression? (',' Expression)*
YieldStmt         ::= contextual 'yield' Expression

SwitchStmt        ::= 'switch' Expression '{' SwitchCase* '}'
SwitchCase        ::= 'case' Pattern Block | 'default' Block
SwitchExpr        ::= 'switch' Expression '{' SwitchArm* '}'
SwitchArm         ::= 'case' Pattern (':' | '->') Expression | 'default' (':' | '->') Expression
                      (* '->' is the legacy ADR-0009 form. Per ADR-0074 (#714) ':' is the preferred separator; the legacy '->' form is still accepted but emits warning GS0302. *)
Pattern           ::= '[' Pattern (',' Pattern)* ']'
                    | '{' identifier ':' Pattern (',' identifier ':' Pattern)* '}'
                    | identifier 'is' TypeClause
                    | '_'
                    | ('<' | '<=' | '>' | '>=' | '==' | '!=') Expression
                    | Expression

TryStmt           ::= 'try' Block CatchClause* FinallyClause?
CatchClause       ::= 'catch' '(' identifier TypeClause? ')' Block
FinallyClause     ::= 'finally' Block
ThrowStmt         ::= 'throw' Expression
UsingStmt         ::= 'using' VariableDecl
DeferStmt         ::= 'defer' Expression
GoStmt            ::= 'go' Expression
ScopeStmt         ::= 'scope' Block
AwaitForRangeStmt ::= 'await' 'for' identifier (contextual 'in' | ':=' 'range') Expression Block
SelectStmt        ::= 'select' '{' SelectCase* '}'
SelectCase        ::= 'default' Block
                    | 'case' '<-' Expression Block
                    | 'case' identifier ':=' '<-' Expression Block
                    | 'case' Expression '<-' Expression Block
ChannelSendStmt   ::= Expression '<-' Expression

Expression        ::= AssignmentExpression
Assignment        ::= identifier '=' Assignment
                    | identifier CompoundAssign Assignment
                    | identifier '[' Expression ']' '=' Assignment
                    | identifier '.' identifier '=' Assignment
                    | AccessorExpression ('+=' | '-=') Assignment
                    | BinaryExpression
BinaryExpression  ::= PrefixExpression (BinaryOperator PrefixExpression)*
PrefixExpression  ::= ('+' | '-' | '!' | '^' | '*' | '&' | '<-' | 'await') PrefixExpression | PostfixExpression
PostfixExpression ::= PrimaryExpression '!!'* (('.' | '?.') NameOrCall | ('[' | '?[') Expression ']')* ('with' '{' FieldEqualsList? '}')?
PrimaryExpression ::= Literal | identifier | Call | GenericCall | StructLiteral | ArrayLiteral | MapLiteral | FunctionLiteral | LambdaExpression | SwitchExpr | '(' Expression ')' | TupleLiteral | MakeChannel | TypeOf | NameOf
Literal           ::= Number | String | InterpolatedString | 'true' | 'false' | 'nil' | char
InterpolatedString ::= '"' ( InterpolationText | '$$' | '$' identifier | InterpolationHole )* '"'
InterpolationHole ::= '${' Expression ( ',' Expression )? ( ':' FormatText )? '}'
Call              ::= identifier '(' Arguments? ')' TrailingLambda?
GenericCall       ::= identifier TypeArgList ('(' Arguments? ')' TrailingLambda? | StructLiteralBody)
StructLiteral     ::= identifier '{' FieldInitList? '}'
FieldInitList     ::= identifier ':' Expression (',' identifier ':' Expression)* ','?
FieldEqualsList   ::= identifier '=' Expression (',' identifier '=' Expression)* ','?
ArrayLiteral      ::= '[' Number? ']' identifier '{' ExpressionList? '}'
MapLiteral        ::= 'map' '[' TypeClause ']' TypeClause '{' MapEntryList? '}'
MapEntry          ::= Expression ':' Expression
FunctionLiteral   ::= 'func' '(' Parameters? ')' TypeClause? Block | 'async' 'func' '(' Parameters? ')' TypeClause? Block
LambdaExpression  ::= '(' Parameters? ')' '->' ( Expression | Block )
TrailingLambda    ::= FunctionLiteral
MakeChannel       ::= 'make' '(' 'chan' TypeClause (',' Expression)? ')'
TypeOf            ::= 'typeof' '(' TypeClause ')'
NameOf            ::= 'nameof' '(' Expression ')'
TupleLiteral      ::= '(' Expression ',' Expression (',' Expression)* ')'
Arguments         ::= (Expression | identifier '=' Expression) (',' (Expression | identifier '=' Expression))*
```
