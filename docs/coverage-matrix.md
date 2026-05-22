# GSharp coverage matrix

Front-end vs. back-end coverage of every distinct surface-language construct, traced from "lexer produces a token" → "parser builds a syntax node" → "binder lowers to a bound node" → "emitter writes IL" (and the interpreter's `Evaluator`, which `design/Gsharp-design-v0.1.md` declares the semantic source of truth).

This file is the **golden** for the coverage-matrix introspection test (`test/Core.Tests/CoverageMatrix/`, execution plan §0.5). A new `SyntaxKind`, `BoundNodeKind`, or `BoundBinaryOperator`/`BoundUnaryOperator` entry that lands without an update here will fail that test on CI. The original prose source is `~/gsharp-gaps.md` §5; this file is the in-repo canonical copy.

Findings are based on `src/Core/CodeAnalysis/{Syntax/Lexer.cs, Syntax/Parser.cs, Binding/Binder.cs, Binding/BoundBinaryOperator.cs, Binding/BoundUnaryOperator.cs, Emit/ReflectionMetadataEmitter.cs}`.

Legend: ✅ = supported end-to-end. 🟡 = partially supported (caveats in the Notes column). ❌ = not implemented. — = not applicable at that layer.

## Tokens

| Token / class | Lexer | Reachable by parser? | Notes |
| --- | --- | --- | --- |
| Numeric literal | ✅ | ✅ | Decimal, `0x` hex, `0o` octal, `0b` binary (Phase 1.3); `_` allowed between digits and after the prefix. Floats / Go-style leading-zero octal not yet supported. |
| String literal (double-quoted) | ✅ | ✅ | Includes Kotlin-style interpolation (`$ident`, `${expr}`) lowered to `+`-chain with `Convert.ToString` (Phase 1.1). `$$` escapes a literal `$`. |
| Raw string literal (backtick) | ✅ | ✅ | Phase 1.2: contents verbatim, no escapes, CRLF/CR normalized to LF, multi-line allowed; embedded backticks not representable. |
| Identifier | ✅ | ✅ | Unicode-aware via `char.IsLetter`/`char.IsLetterOrDigit` (categories Lu/Ll/Lt/Lm/Lo/Nl + Nd). Surrogate pairs not yet supported. See `docs/lexical.md`. |
| `++` / `--` | ✅ | ✅ | Statement-only (Phase 2.2); the parser desugars `i++`/`i--` to `i = i ± 1` so the rest of the pipeline is unchanged. `let y = x++` is rejected at parse time. |
| Compound assignment (`+=`, `-=`, `*=`, `/=`, `%=`, `^=`, `&=`, `|=`, `&^=`, `<<=`, `>>=`) | ✅ | ✅ | Phase 2.1: the parser desugars `x op= rhs` to `x = x op rhs`; the binder/lowerer/emitter need no per-operator change. |
| `[` / `]` | ✅ | ❌ | No syntax node consumes them; indexing/slicing unreachable. |
| `;` | ✅ | ❌ | Only synthesized internally; no statement separator role in source. |
| `<-` (channel send/recv arrow) | ✅ | 🟡 | Parsed only as a unary operator (`ParseBinaryExpression` calls it via `GetUnaryOperatorPrecedence`). No bound form → binder rejects. |
| `&^` (Go bit-clear) | ✅ | ✅ | End-to-end for `int` operands; emitter implements as `not; and`. |

## Top-level constructs

| Construct | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| `package A.B.C` | ✅ | ✅ | ✅ | ✅ | Dotted; no aliases. |
| `import A.B.C` | ✅ | ✅ | ✅ | ✅ | Aliased form `import alias = path` lands in Phase 1.4. Implicit `import System` is on by default (Phase 1.5; opt-out via `gsc /noimplicitimports`). No parenthesized groups, no string-path imports, no per-file `import` blocks. |
| Top-level statements | ✅ | ✅ | ✅ | ✅ | Entry point synthesized; one file may carry them. |
| `func name(params) Ret { … }` | ✅ | ✅ | ✅ | ✅ | Single return type only. |
| Multiple return values / named returns / variadic / receivers / generic params | ❌ | — | — | — | |

## Statements

| Statement | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| Block `{ … }` | ✅ | ✅ | ✅ | ✅ | |
| `var x [T] = e` / `let x [T] = e` / `const x [T] = e` | ✅ | ✅ | ✅ | ✅ | Single identifier; no `var (…)` group. `let` (since Phase 1.6) is an immutable runtime binding — same binder behavior as `const`. |
| `x := e` | ✅ | ✅ | ✅ | ✅ | Single identifier; no `a, b := …`. |
| `x = e` | ✅ | ✅ | ✅ | ✅ | Single identifier on LHS. |
| `if cond stmt [else stmt]` | ✅ | ✅ | ✅ | ✅ | No `if init; cond` form. |
| `for { }` (infinite) | ✅ | ✅ | ✅ | ✅ | |
| `for i := lo ... hi { }` | ✅ | ✅ | ✅ | ✅ | GSharp-specific; not Go's `for i := lo; i < hi; i++`. |
| `for cond { }` (while-style) | ✅ | ✅ | ✅ | ✅ | Lowered in the binder to `goto checkLabel; body; check: if cond goto body`. |
| `for init; cond; post { }` (C-style) | ✅ | ✅ | ✅ | ✅ | Header parts are all optional; `for ;; { }` is the infinite form. `continue` jumps to `post` then re-evaluates `cond`. |
| `for k, v := range coll` | ❌ | — | — | — | |
| `break` / `continue` | ✅ | ✅ | ✅ | ✅ | No labels. |
| `return [e]` | ✅ | ✅ | ✅ | ✅ | Single expr; line-sensitive. |
| `switch` / `case` / `default` / `fallthrough` | ❌ | — | — | — | Keywords reserved. |
| `defer` | ❌ | — | — | — | Keyword reserved. |
| `go` (goroutine) | ❌ | — | — | — | Keyword reserved. |
| `select` | ❌ | — | — | — | Keyword reserved. |
| `goto` / labels | ❌ | 🟡 | 🟡 | 🟡 | `BoundGotoStatement` / `BoundLabelStatement` exist as **lowering artifacts** for `for`/`if`; not surfaceable from source. |
| Send statement `ch <- v` / receive `<-ch` | ❌ | — | — | — | |
| Increment/decrement statement (`i++`, `i--`) | ✅ | ✅ | ✅ | ✅ | Parser desugars to `i = i ± 1` (Phase 2.2). Statement-only — not valid in expression position. |
| `type` declaration (alias or defined type) | ❌ | — | — | — | Keyword reserved. |

## Expressions

| Expression | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| Integer / string / bool literal | ✅ | ✅ | ✅ | ✅ | Emitter literal table covers only `int`/`string`/`bool`. |
| Name | ✅ | ✅ | ✅ | ✅ | |
| Call `f(args)` | ✅ | ✅ | ✅ | ✅ | |
| Member access `a.b.c` | ✅ | ✅ | ✅ | ✅ | `AccessorExpressionSyntax`; resolves through `ReferenceResolver` to imported CLR types. |
| Parenthesized | ✅ | ✅ | ✅ | ✅ | |
| Assignment expression `x = e` | ✅ | ✅ | ✅ | ✅ | Identifier LHS only. |
| Indexing `a[i]` / slicing `a[lo:hi]` | ❌ | — | — | — | |
| Composite literal `T{…}` | ❌ | — | — | — | |
| Type assertion / conversion (`x.(T)`, `T(x)`) | 🟡 | 🟡 | — | 🟡 | Built-in type names invoked as `int(x)` route through `BindCallExpression` → `BindConversion`; emit currently only handles bool↔int. Go-style `x.(T)` does not exist. |
| Address-of `&x` / dereference `*x` | 🟡 | ❌ | — | — | Parsed as unary, but no `BoundUnaryOperator` entry → binder rejects. The `Loop.gs` design sample's `*count` is **unimplementable today**. |
| Channel receive `<-ch` | 🟡 | ❌ | — | — | Parsed; no binding. |
| Higher-order call `f()(args)` / function values | ❌ | — | — | — | |
| Function literal / lambda | ❌ | — | — | — | |

## Operators (semantic coverage)

`BoundBinaryOperator` and `BoundUnaryOperator` enumerate every operator the binder will accept. The parser otherwise produces all Go tokens.

| Operator | int | bool | string | Imported types |
| --- | --- | --- | --- | --- |
| `+` | ✅ | — | ✅ (string concat via `String.Concat`) | ❌ |
| `-` `*` `/` `%` | ✅ | — | — | ❌ |
| `<<` `>>` | ✅ | — | — | ❌ |
| `&` `\|` `^` `&^` | ✅ | partial (`&`/`\|`/`^` ✅, `&^` ❌) | — | ❌ |
| `&&` `\|\|` | — | ✅ | — | ❌ |
| `==` `!=` | ✅ | ✅ | ✅ (via `String.Equals`) | ❌ |
| `<` `<=` `>` `>=` | ✅ | — | — | ❌ |
| unary `+` `-` `^` | ✅ | — | — | ❌ |
| unary `!` | — | ✅ | — | — |
| unary `*` `&` `<-` | ❌ | ❌ | ❌ | ❌ |

Implicit and explicit conversions: `BindConversion` exists but the emitter (`EmitConversion`) currently implements **only** `int ↔ bool` round-trips. Any other conversion the binder considers legal (e.g., to/from imported CLR types) will throw `NotSupportedException` at emit time. This is the largest binder/emit asymmetry in the codebase.

## Top-line takeaways

1. **The dominant gap is parser → binder**, not binder → emit. The emitter implements essentially every bound node the binder can currently produce; failures show up as parser-rejections or binder "operator/conversion not supported" diagnostics.
2. **Two design samples already exceed the implementation.** `samples/Loop.gs` (pre-Phase-0 rewrite) and `design/Gsharp-design-v0.1.md` use C-style `for init; cond; post`, `args[0]` indexing, `i--`, and `*count` — none of which parse today. The Phase-0 rewrite of `samples/Loop.gs` removes those constructs; the v0.1 design Loop section is annotated as aspirational pointing at `design/Gsharp-design-v0.2.md`.
3. **String interpolation is real (Phase 1.1).** `"Count value: $i"` lexes as an `InterpolatedStringToken`, parses as `InterpolatedStringExpressionSyntax`, and lowers in the binder to a `+`-chain over `Convert.ToString` calls — emitted unchanged.
4. **The emitter caps literals at `int`/`string`/`bool`.** Adding any new literal kind (float, char/rune, null) requires coordinated lexer + binder + `EmitLiteral` changes.
5. **`int ↔ bool` is the only conversion path that emits.** Before adding numeric types or imported-type conversions to the binder, `EmitConversion` must be extended; otherwise valid programs will compile under the interpreter and crash the emitter.
