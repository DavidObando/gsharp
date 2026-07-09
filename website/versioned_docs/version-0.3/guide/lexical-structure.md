---
title: "Lexical structure"
sidebar_position: 2
draft: false
---

# Lexical structure

This guide explains the tokens G# recognizes today. For the normative grammar, see the [language specification](/docs/ref/spec).

## Source text and comments

G# source is Unicode text. Line terminators are LF, CR, or CRLF. Whitespace separates tokens but is otherwise insignificant outside literals. Use `//` for line comments and `/* ... */` for block comments; block comments do not nest, and an unterminated block comment is a lexical diagnostic. Documentation comments begin with `///`: consecutive `///` lines are concatenated and attached to the following declaration, where they are parsed as Markdown and lowered to CLR XML doc.

## Identifiers and keywords

Identifiers start with a Unicode letter or `_` and continue with Unicode letters, digits, or `_`. The lexer uses .NET Unicode classification, so non-ASCII letters are accepted.

The reserved keywords may not be used as identifiers. The complete set is:

- Declarations: `package`, `import`, `using`, `type`, `func`, `operator`, `var`, `let`, `const`
- Type and member kinds: `class`, `struct`, `interface`, `enum`, `map`, `sequence`, `chan`
- Control flow: `if`, `else`, `for`, `while`, `do`, `switch`, `case`, `default`, `fallthrough`, `break`, `continue`, `goto`, `guard`, `range`, `return`
- Pattern and cast: `is`, `as`
- Concurrency: `go`, `select`, `scope`, `defer`, `async`, `await`
- Exceptions: `try`, `catch`, `finally`, `throw`
- Access and inheritance modifiers: `public`, `internal`, `protected`, `private`, `open`, `override`, `sealed`
- Literals: `true`, `false`, `nil`

Some words are contextual: `data`, `inline`, `partial`, `prop`, `event`, `shared`, `init`, `get`, `set`, `add`, `remove`, `raise`, `in`, `out`, `yield`, `with`, `unsafe`, `fixed`, `stackalloc`, `sizeof`, `typeof`, `nameof`, `unmanaged`, `object`, and `make` are ordinary identifiers except in the syntax positions that give them special meaning.

## Numeric literals

Use explicit prefixes for non-decimal integers: `0x` for hexadecimal, `0o` for octal, and `0b` for binary. Underscores can group digits, including immediately after a base prefix, but cannot be trailing.

Integer suffixes are case-insensitive: `L` for `int64`, `U` for `uint32`, and `UL` or `LU` for `uint64`. Unsuffixed decimal integers use the first type that can hold the value: `int32`, then `uint32`, then `int64`, then `uint64`; values beyond `uint64` are rejected. Unsuffixed non-decimal values fitting `uint32` are bit-cast to `int32` for compatibility, and wider non-decimal values follow the 64-bit lattice.

Floating literals are decimal only. Valid forms include `1.5`, `.5`, `1e10`, and `1.5e-3`. The current lexer does not treat `1.` as a float because the dot would conflict with member access; a digit must follow the dot. Unsuffixed floating literals are `float64`. Floating suffixes are case-insensitive: `F` for `float32`, `D` for `float64`, and `M` for `decimal`.


## Characters and strings

A character literal is one UTF-16 code unit or escape in single quotes. Supported escapes are the C-style escapes (`\'`, `\"`, `\\`, `\0`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v`), hex escapes (`\x` with one to four hex digits), and Unicode escapes (`\u` with exactly four hex digits, `\U` with exactly eight hex digits constrained to a single code unit).
Normal strings are double-quoted and interpret the same backslash escapes as character literals, so a literal double quote is written `\"`. There is no doubled-quote (`""`) escaping. Raw strings are backtick-delimited, can span lines, normalize CR and CRLF to LF, cannot contain a backtick, and do not process escapes or interpolation.
Interpolated strings are sigil-free: holes live inside ordinary double-quoted strings rather than behind a C#-style `$"…"` prefix. A hole is `$name` (a single identifier) or a braced `${expression}`, optionally with an alignment and format clause, `${expr,alignment:format}`. Use `$$` for a literal dollar sign; there is no `{{`/`}}` brace escaping. The braced-hole scanner is delimiter-aware — it balances brackets, skips nested string and char literals and comments, and allows the expression to span lines — so `${dict["k"]}`, `${cond ? "a" : "b"}`, and multiline holes all work. Holes are real code: hover, go-to-definition, find-references, completion, and signature help all work inside `${…}`.

```gsharp title="samples/InterpolatedString.gs"
package InterpolatedString

let name = "world"
let n = 6
Console.WriteLine("Hello, $name!")
Console.WriteLine("answer = ${n * 7}")
Console.WriteLine("$$ stays literal")
```


## Operators and punctuation

G# includes compact operators plus CLR-oriented additions: non-null assertion `!!`, null-conditional access `?.`, null-conditional indexing `?[`, null coalescing `??`, null-coalescing compound assignment `??=`, from-end indexing `^`, ranges `..`, postfix and prefix `++` / `--`, channel receive and send `<-`, the lambda, function-type, and expression-bodied-member arrow `->`, and annotations introduced by `@`. The `->` arrow introduces a lambda body (`(x int32) -> x * 2`, or the bare single-parameter `x -> x * 2`), a function-type clause (`(T1, T2) -> R`), or a one-expression member body; switch-expression and switch-statement arms use a colon `:`. Compound assignment exists for arithmetic, bitwise, bit-clear, and shift operators.

`null`, `nameof`, `typeof`, `sizeof`, and `make` are not all keywords. `null` is not a keyword at all: it is an ordinary identifier, and the null literal is `nil`. `nameof`, `typeof`, `sizeof`, and `make` are contextual identifiers.
