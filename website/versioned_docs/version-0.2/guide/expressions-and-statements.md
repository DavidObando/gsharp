---
title: "Expressions and statements"
sidebar_position: 5
draft: false
---

# Expressions and statements

G# expression syntax is compact and Go-like, with CLR-oriented additions for nullability, async, exceptions, and interop. The exact precedence table is in the [language specification](/docs/ref/spec#precedence).

## Operators

Unary operators include numeric identity and negation, logical not, bitwise complement, address-of, dereference, channel receive, and `await`. Binary operators are left-associative. Multiplicative, shift, bitwise, additive, comparison, logical-and, logical-or, and null-coalescing levels are implemented. The type-test operator `expr is T` returns `bool` and the safe-cast operator `expr as T` returns `T` (or `T?` for value types) or `nil` on failure; both sit at the comparison precedence level. The conditional (ternary) expression `cond ? whenTrue : whenFalse` is a normal expression (ADR-0062); both arms must share a common type, otherwise `GS0263` fires. User operator overloads are supported through receiver `operator` declarations; see [ADR-0026](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0026-operator-by-name-deferral.md) and [ADR-0035](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0035-user-operator-overloads.md).

## Calls, access, and literals

Calls use parentheses. Generic calls use bracketed type arguments. Member access uses `.`, null-conditional access uses `?.`, indexing uses brackets, and null-conditional indexing uses `?[` (ADR-0073). These postfix operators chain after any primary expression, including a parenthesized one — `(a + b).GetType()`, `(nums)[0]`, and `("s").Length` are all valid. The one exception is a bare numeric literal: write `(42).ToString()` rather than `42.ToString()`, which is ambiguous with float-literal lexing (see [ADR-0054](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0054-postfix-member-access-on-primary-expressions.md)). Struct literals use field labels; data structs can be copied with `with` updates.

`a?[i]` evaluates the receiver `a` exactly once; when it is `nil` the whole expression yields `nil` and the index is not evaluated, otherwise the result is the indexed value lifted to the nullable form of the indexer's return type. Chained forms (`h?.Data?[i]?.Length`) short-circuit on the first nil receiver. Null-conditional forms (`?.`, `?[]`) are not allowed on the left-hand side of an assignment (diagnostic GS0301).

Arguments may be positional, named (`f(timeout: 30, retries: 3)`), or ref-kind-prefixed (`f(ref x)`, `f(out var n)`, `f(in z)`). Named arguments work for free functions, user methods, user constructors, extension functions, and inherited CLR methods (including delegate `Invoke`); indirect calls through a function-typed variable and variadic call sites do not accept names. Ref-kind modifiers must match the parameter declaration (`GS0235`); passing a value to an `in` parameter requires an explicit `in` at the call site (`GS0242`).

```gsharp
let p = Point{X: 3, Y: 4}
let q = p with { X = 10 }
let value = maybePoint?.X ?: 0
let first = matrix?[0]?[0] ?: -1
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

Use declaration statements for new bindings and assignment for existing variables. Multi-target assignment is implemented for identifier lists. Tuple and named deconstruction use `let` forms. The null-coalescing compound assignment `a ??= b` writes `b` into `a` only when `a` currently reads as `nil` — the right-hand side is short-circuited otherwise (ADR-0072).

```gsharp
let (x, y) = pair
left, right = right, left
count += 1

var greeting string? = nil
greeting ??= "hello"   // greeting is now "hello"
greeting ??= "ignored" // no-op — RHS not evaluated
```

## If and switch

`if` can include a simple statement before the condition. Switch statements use block-bodied cases and do not fall through. `fallthrough` is reserved and diagnosed if used. Switch expressions use `->` arms and require semantic coverage or a default arm. Rationale: [ADR-0009](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0009-switch-semantics.md) and [ADR-0013](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0013-no-fallthrough.md).

```gsharp
let label = switch n {
case 0: "zero"
case 1: "one"
default: "many"
}
```

`if` itself is also a value-producing expression (ADR-0064). In expression position the form requires an exhaustive `else` chain and uses brace blocks whose last expression is the branch value — there is no `yield`. The result type is the common type of every branch tail, computed by the same rule as the `?:` ternary. Multi-statement blocks run their prefix statements for side effects and then yield the trailing expression.

```gsharp
let label = if n > 0 { "positive" }
           else if n < 0 { "negative" }
           else { "zero" }

let title = if user.IsAdmin {
    log("admin route")
    "Admin Dashboard"
} else {
    "Home"
}
```

Missing the terminal `else` in value position reports `GS0276`. A block with no trailing expression in value position reports `GS0277`. Branches with no common type report `GS0263` (shared with the ternary). The existing if-statement form (`if cond { … }` with optional `else`, optional simple-statement initializer) is unchanged.

## Loops

G# has infinite `for`, condition `for`, three-part `for`, `for in`, and ellipsis range loops. It does not implement a `while` keyword; use `for condition { ... }` for while-style control flow. `for in` is the canonical collection iteration spelling from [ADR-0031](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0031-canonical-for-in.md). The legacy `for v := range coll` and `for i := lo ... hi` spellings were removed in [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md); use the `in` form.

```gsharp
for item in items {
    Console.WriteLine(item)
}

for i in 0...10 {
    Console.WriteLine(i)
}
```

## Return, yield, await

`return` may return zero, one, or multiple expressions; multiple expressions are represented as a tuple. `yield` appears in iterator functions returning `sequence[T]`. `await` is a prefix expression valid in async contexts. `await for` consumes asynchronous sequences.

## Exceptions and cleanup statements

`throw`, `try`, `catch`, and `finally` use CLR exception semantics. `using` introduces a disposable resource variable. `defer` schedules a call for scope exit. See [Errors and cleanup](/docs/guide/errors-and-cleanup).

## Concurrency statements

`go` starts a concurrent call; `scope` joins child work at block exit. Channel send is `ch <- value`; receive is the prefix expression `<-ch`. `select` waits on channel operations and optional default cases. See [Concurrency and async](/docs/guide/concurrency-async).
