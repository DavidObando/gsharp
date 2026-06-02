---
title: "Expressions and statements"
sidebar_position: 5
draft: false
---

# Expressions and statements

G# expression syntax is compact and Go-like, with CLR-oriented additions for nullability, async, exceptions, and interop. The exact precedence table is in the [language specification](/docs/ref/spec#precedence).

## Operators

Unary operators include numeric identity and negation, logical not, bitwise complement, address-of, dereference, channel receive, and `await`. Binary operators are left-associative. Multiplicative, shift, bitwise, additive, comparison, logical-and, logical-or, and null-coalescing levels are implemented. User operator overloads are supported through receiver `operator` declarations; see [ADR-0026](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0026-operator-by-name-deferral.md) and [ADR-0035](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0035-user-operator-overloads.md).

## Calls, access, and literals

Calls use parentheses. Generic calls use bracketed type arguments. Member access uses `.`, null-conditional access uses `?.`, and indexing uses brackets. These postfix operators chain after any primary expression, including a parenthesized one — `(a + b).GetType()`, `(nums)[0]`, and `("s").Length` are all valid. The one exception is a bare numeric literal: write `(42).ToString()` rather than `42.ToString()`, which is ambiguous with float-literal lexing (see [ADR-0054](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0054-postfix-member-access-on-primary-expressions.md)). Struct literals use field labels; data structs can be copied with `with` updates.

```gsharp
let p = Point{X: 3, Y: 4}
let q = p with { X = 10 }
let value = maybePoint?.X ?: 0
let kind = (p.X + p.Y).GetType()
```

Function literals are written with `func` or `async func`. A trailing lambda may follow a call as the final argument. There is no arrow-lambda expression today; `->` is used for switch expression arms. See [ADR-0050](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0050-trailing-arrow-lambda.md) for the design discussion behind trailing lambda syntax and the current parser behavior.

## Interpolation

Interpolated strings evaluate `$name` and braced `${expression}` fragments inside normal double-quoted strings — there is no `$"…"` prefix. A braced hole may add an alignment and format clause, `${expr,alignment:format}`, and the delimiter-aware scanner lets a hole contain nested strings, indexers, ternaries, and even newlines. Use `$$` for a literal dollar sign. By default an interpolation lowers to `DefaultInterpolatedStringHandler`; targeting `IFormattable`/`FormattableString` defers formatting via `FormattableStringFactory.Create`. Keep complex interpolation expressions readable by computing intermediate `let` values.

```gsharp
let value = 255
let label = "hi"
Console.WriteLine("hex=${value:X4}")
Console.WriteLine("padded=[${label,5}]")
```

## Declarations, assignment, and deconstruction

Use declaration statements for new bindings and assignment for existing variables. Multi-target assignment is implemented for identifier lists. Tuple and named deconstruction use `let` forms.

```gsharp
let (x, y) = pair
left, right = right, left
count += 1
```

## If and switch

`if` can include a simple statement before the condition. Switch statements use block-bodied cases and do not fall through. `fallthrough` is reserved and diagnosed if used. Switch expressions use `->` arms and require semantic coverage or a default arm. Rationale: [ADR-0009](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0009-switch-semantics.md) and [ADR-0013](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0013-no-fallthrough.md).

```gsharp
let label = switch n {
case 0 -> "zero"
case 1 -> "one"
default -> "many"
}
```

## Loops

G# has infinite `for`, condition `for`, three-part `for`, `for in`, `for := range`, and ellipsis range loops. It does not implement a `while` keyword; use `for condition { ... }` for while-style control flow. `for in` is the canonical collection iteration spelling from [ADR-0031](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0031-canonical-for-in.md).

```gsharp
for item in items {
    Console.WriteLine(item)
}

for i := 0...10 {
    Console.WriteLine(i)
}
```

## Return, yield, await

`return` may return zero, one, or multiple expressions; multiple expressions are represented as a tuple. `yield` appears in iterator functions returning `sequence[T]`. `await` is a prefix expression valid in async contexts. `await for` consumes asynchronous sequences.

## Exceptions and cleanup statements

`throw`, `try`, `catch`, and `finally` use CLR exception semantics. `using` introduces a disposable resource variable. `defer` schedules a call for scope exit. See [Errors and cleanup](/docs/guide/errors-and-cleanup).

## Concurrency statements

`go` starts a concurrent call; `scope` joins child work at block exit. Channel send is `ch <- value`; receive is the prefix expression `<-ch`. `select` waits on channel operations and optional default cases. See [Concurrency and async](/docs/guide/concurrency-async).
