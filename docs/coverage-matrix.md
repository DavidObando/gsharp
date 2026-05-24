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
| `<-` (channel send/recv arrow) | ✅ | ✅ | Phase 5.4 / 5.5 / ADR-0022 (interpreter). Receive `<-ch` parses as a unary expression; the binder special-cases the `<-` token to a `BoundChannelReceiveExpression` typed as the channel element type. Send `ch <- v` is recognised at statement scope (an expression followed by `<-` becomes a `ChannelSendStatementSyntax`) and binds to `BoundChannelSendStatement`. Non-channel operands diagnose. Emit deferred. |
| `->` (switch-expression arm arrow) | ✅ | ✅ | Phase 6.1: separates `case` / `default` arms from result expressions in `switch` expressions. |
| `&^` (Go bit-clear) | ✅ | ✅ | End-to-end for `int` operands; emitter implements as `not; and`. |

## Top-level constructs

| Construct | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| `package A.B.C` | ✅ | ✅ | ✅ | ✅ | Dotted; no aliases. |
| `import A.B.C` | ✅ | ✅ | ✅ | ✅ | Aliased form `import alias = path` lands in Phase 1.4. Implicit `import System` is on by default (Phase 1.5; opt-out via `gsc /noimplicitimports`). No parenthesized groups, no string-path imports, no per-file `import` blocks. |
| Top-level statements | ✅ | ✅ | ✅ | ✅ | Entry point synthesized; one file may carry them. |
| `func name(params) Ret { … }` | ✅ | ✅ | ✅ | ✅ | Single return type only. Accepts optional `public`/`internal`/`private` modifier (Phase 2.8); default is `public` per ADR-0014. |
| Multiple return values / named returns | ❌ | — | — | — | |
| Receiver-clause functions `func (r R) M(...)` | ✅ | ✅ | ✅ | ✅ | Phase 3.B.6 + Phase 6.4: Form A is shared. If `R` is declared in the same package and is a `struct` or `class`, the declaration is appended to `R`'s method set and dispatches like an instance method. If `R` is a cross-package, CLR, or primitive type, it remains an extension function with the receiver as parameter 0. Same-package interface/enum/alias receivers diagnose. |
| Variadic / generic function parameters | ✅ | ✅ | ✅ | ✅ | Variadic `...T` is supported on function declarations and calls; generic function type parameters use `func Name[T any](...)`. |
| `public` / `internal` / `private` modifiers | ✅ | ✅ | ✅ (func) | — | Phase 2.8 / ADR-0014: allowed on top-level `func`, `type`, `var`, `let`, `const`. Default is `public`. Emitter maps to `MethodAttributes.Public`/`Assembly`/`Private` for functions; global-variable accessibility is recorded for future field emission. |

## Statements

| Statement | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| Block `{ … }` | ✅ | ✅ | ✅ | ✅ | |
| `var x [T] = e` / `let x [T] = e` / `const x [T] = e` | ✅ | ✅ | ✅ | ✅ | Single identifier; no `var (…)` group. `let` (since Phase 1.6) is an immutable runtime binding — same binder behavior as `const`. |
| `x := e` | ✅ | ✅ | ✅ | ✅ | Single and multi-target forms (Phase 2.3): `a, b := 1, 2` declares N variables. Call-form `a, b := f()` still waits on Phase 4 multi-return. |
| `x = e` | ✅ | ✅ | ✅ | ✅ | Single and multi-target forms (Phase 2.3): `a, b = b, a` evaluates every RHS into a fresh temporary before any assignment lands, matching Go's swap semantics. |
| `if cond stmt [else stmt]` | ✅ | ✅ | ✅ | ✅ | No `if init; cond` form. |
| `for { }` (infinite) | ✅ | ✅ | ✅ | ✅ | |
| `for i := lo ... hi { }` | ✅ | ✅ | ✅ | ✅ | GSharp-specific; not Go's `for i := lo; i < hi; i++`. |
| `for cond { }` (while-style) | ✅ | ✅ | ✅ | ✅ | Lowered in the binder to `goto checkLabel; body; check: if cond goto body`. |
| `for init; cond; post { }` (C-style) | ✅ | ✅ | ✅ | ✅ | Header parts are all optional; `for ;; { }` is the infinite form. `continue` jumps to `post` then re-evaluates `cond`. |
| `for k, v := range coll` | ✅ | ✅ | ✅ | ❌ | Phase 4 exit: binder + interpreter support iterating over arrays/slices (index-based), CLR `IDictionary[K,V]` (key/value), and CLR `IEnumerable[T]` (element-with-counter). Lowerer rewrites to existing `BoundIndexExpression`/`BoundLenExpression` for arrays and to `GetEnumerator`/`MoveNext`/`Current` reflection calls for CLR collections. Emit gap remains. |
| `break` / `continue` | ✅ | ✅ | ✅ | ✅ | No labels. |
| `return [e]` | ✅ | ✅ | ✅ | ✅ | Single expr; line-sensitive. |
| `switch` / `case` / `default` | ✅ | ✅ | — | ✅ | Phase 2.6: statement switch; Phase 6.2 case values now bind as patterns (constant, discard, type, property, relational, list) and the interpreter dispatches a `BoundPatternSwitchStatement`. Phase 6.3 diagnoses non-exhaustive enum and sealed-interface statement switches when no top-level discard/default arm is present; duplicate-covered variants are accepted until unreachable-arm analysis lands. Phase 6.6 ✅ narrows nullable discriminants inside type-pattern and non-nil constant-pattern arms. Each case body is a brace block. Emit for pattern-bearing switch statements is deferred. |
| `fallthrough` | ❌ | — | — | — | ADR-0013 rejects Go-style implicit case fallthrough. The keyword remains reserved; the parser emits a diagnostic if it appears. |
| `defer` | ❌ | — | — | — | Keyword reserved. |
| `go` (goroutine) | ✅ | ✅ | — | ✅ | Phase 5.3 / ADR-0022 (interpreter). `go <call>` schedules the call on a fire-and-forget `Task.Run`. Only call expressions are accepted as operands. The interpreter serializes body execution with a monitor on the evaluator to keep the shared locals/globals stacks safe; concurrency is observational rather than parallel. Emit deferred. |
| `select` | ✅ | ✅ | — | ✅ | Phase 5.6 / ADR-0022 (interpreter). Arms: `case <-ch { … }` (recv-discard), `case v := <-ch { … }` (recv-bind — declares `v` typed as the channel's element type, visible only in the arm body), `case ch <- v { … }` (send), and at most one `default { … }`. Body uses brace-block (consistent with GSharp's `switch`), not Go's colon-terminator. Empty `select { }` and duplicate `default` arms diagnose; send/receive operand type-checks reuse the existing channel diagnostics. Evaluator implements the ADR-0022 algorithm: snapshot channels, source-order `TryRead` / `TryWrite` per arm, take `default` if present and no arm is ready, otherwise block on `Task.WhenAny` of per-arm `WaitToRead/WriteAsync` and retry. Drained-closed receive surfaces as the element type's zero value. Lowerer flattens each arm body so nested `if`/`for`/etc. inside arms work end-to-end (Phase 5 exit). Emit deferred. |
| `async func` / `await e` | ✅ | ✅ | — | ✅ | Phase 5.1+5.2 / ADR-0023 (interpreter). `async` is a `func` modifier; the call-site return type is wrapped as `Task` / `Task[T]`. `await` is an expression that unwraps the awaited element type. The interpreter realizes an async function as `Task.FromResult(body-result)` and `await` blocks via `GetAwaiter().GetResult()`. Emit deferred to Phase 7 (state machine). |
| `scope { … }` | ✅ | ✅ | — | ✅ | Phase 5.7 / ADR-0022 (interpreter). `scope { … }` opens a structured-concurrency block; the body binds in a fresh lexical scope. `go` statements lexically inside the body have their backing `Task` registered with the innermost scope frame instead of being fire-and-forget. At scope exit the evaluator awaits `Task.WhenAll` on the frame's tasks; on any failure the scope's `CancellationTokenSource` is cancelled (cooperative shut-down of sibling tasks) and the first failure is rethrown — additional failures attach as `AggregateException.InnerExceptions[1..]`. Nested `scope` blocks compose via a stack of frames. Lowerer flattens the body so nested `if`/`for`/etc. work inside the scope (Phase 5 exit). Source-level `ctx` binding (exposing the scope's CTS), async-aware lowering, and emit are deferred. |
| `await for v := range stream` | ✅ | ✅ | — | ✅ | Phase 5.8 / ADR-0023 (interpreter). The stream operand must implement `IAsyncEnumerable[T]`; the loop variable is typed as `T`. The interpreter realizes the iteration by reflectively calling `GetAsyncEnumerator(ct)` → looping `MoveNextAsync()` (blocking each `ValueTask` via `.AsTask().GetAwaiter().GetResult()`, the same pragma Phase 5.1 uses for `await`) → assigning `Current` to the loop variable → evaluating the body → `DisposeAsync()` in a `finally`. When the statement is lexically inside a `scope { … }`, the scope's `CancellationTokenSource` is plumbed into `GetAsyncEnumerator`; otherwise `CancellationToken.None`. Operand type-checks surface a dedicated diagnostic. Lowerer flattens the body so nested `if`/`for`/etc. inside the loop work (Phase 5 exit). `break` / `continue` inside the body, the async-aware lowering, and emit are deferred. |
| `goto` / labels | ❌ | 🟡 | 🟡 | 🟡 | `BoundGotoStatement` / `BoundLabelStatement` exist as **lowering artifacts** for `for`/`if`; not surfaceable from source. |
| Send statement `ch <- v` / receive `<-ch` | ✅ | ✅ | — | ✅ | Phase 5.4 / 5.5 / ADR-0022 (interpreter). `ch <- v` is a `ChannelSendStatementSyntax` at statement scope; `<-ch` is a unary-form expression. The binder requires a `chan T` operand and infers the element type. Interpreter realizes channels as `System.Threading.Channels.Channel[T]` — send is `Writer.WriteAsync(v).AsTask().GetAwaiter().GetResult()`, receive is `Reader.ReadAsync().AsTask().GetAwaiter().GetResult()` (catches `ChannelClosedException` and returns the element type's zero value). Two-value receive (`v, ok := <-ch`), the async-aware lowering, and emit are deferred. |
| Increment/decrement statement (`i++`, `i--`) | ✅ | ✅ | ✅ | ✅ | Parser desugars to `i = i ± 1` (Phase 2.2). Statement-only — not valid in expression position. |
| `type` declaration (alias or defined type) | ✅ | ✅ | — | ✅ | Phase 2.7: `type Name = Other` declares an erased alias resolvable anywhere an `int`/`bool`/`string` (or other alias) is. Defined types (with their own identity) and structural types arrive in Phase 3. |
| `struct` declaration | ✅ | ✅ | ✅ | ✅ | Phase 3.B.1: `type Name struct { Field Type … }` declares a value-typed aggregate. Emitted as a CLR `ValueType` (sealed, sequential layout) under the declaring package's namespace. Composite literal `Name{Field: …}`, field read `p.Field`, and field assignment `p.Field = …` work on both backends with Go-style value semantics (assignment deep-copies). Field assignment receivers are restricted to simple variables for Phase 3.B.1. Phase 6.4 adds top-level Form A methods (`func (p Point) M()`) for same-package structs; they are equivalent to methods in the aggregate method set. |
| `data struct` declaration | ✅ | ✅ | ✅ | ✅ | Phase 3.B.2 / ADR-0029: `type Name data struct { Field Type … }` is a struct whose values compare with structural equality via `==` / `!=`. `data` is a context-sensitive keyword (only special before `struct`); empty `data struct` is a binder diagnostic. Emit lowers `==` / `!=` to a boxed call through `Object.Equals(object, object)`, which routes through the inherited `ValueType.Equals` reflection-based field-by-field comparison — same observable semantics as the interpreter's structural `Equals`/`GetHashCode`/`ToString`. Explicit synthesized `Equals(T)` / `GetHashCode` / `op_Equality` / `Deconstruct` methods on the struct's CLR `TypeDef` are a future iteration. |
| `record` declaration alias | ✅ | ✅ | ✅ | ✅ | Phase 6.7 / ADR-0025: `type Name record { Field Type … }` is a pure parse-time alias for `type Name data struct { Field Type … }`. `record` is contextual and only special in a type-declaration header when followed by `{`; elsewhere it remains an ordinary identifier. The bound tree, symbols, emit, equality semantics, and ADR-0029 synthesized-member behavior are identical to `data struct`. `record class`, positional constructor records, `with` expressions, `open record`, and `sealed record` are out of scope. |
| `type Name enum { A, B, C }` | ✅ | ✅ | — | ✅ | Phase 6.8. Members auto-number from 0. Underlying type is `System.Int32`. `Color.Red` member access; equality only (no ordering). Usable as switch discriminant in both the statement and expression forms. Phase 6.3 exhaustiveness accepts all members covered by constant patterns or a top-level discard/default. Explicit member values (`Red = 5`) and emit are deferred. |
| `class` declaration | ✅ | ✅ | ✅ | ✅ | Phase 3.B.3 (sub-steps 1 + 2 primary ctor + 2b methods + 3 single inheritance): `type Name class { Field Type … }` declares a reference-typed aggregate; `type Name class(p1 T1, p2 T2) { … }` additionally declares a Kotlin-style primary constructor whose parameters become public fields of the same name (ADR-0017 lock-in). Composite literal `Name{Field: …}` continues to work for any class (uses the implicit parameterless ctor); `Name(arg1, arg2)` invokes the declared primary ctor positionally. Body fields not listed in the primary ctor are zero-initialized. Reference semantics: assignment shares the instance and field writes mutate in place so all references observe the update. Methods inside the body (`func Name(args) Ret { body }`) and Phase 6.4 same-package top-level receiver methods (`func (c C) Name(args) Ret { body }`) are dispatched via `receiver.Method(args)`; a bare identifier `X` inside either body resolves to `this.X` if `X` is a field of the enclosing class (implicit-`this` field access and assignment). Method declarations inside a `struct` body are diagnosed. Single inheritance per ADR-0017: `open class Base { open func F() T { … } }` declares a subclassable class with an overridable method; `class Derived : Base { override func F() T { … } }` extends it. Sealed-by-default — subclassing a non-`open` class diagnoses `Class 'X' is not open; declare 'open class X' to allow subclassing.`. Method-side: `open` (overridable), `override` (sealed override), `open override` (overridable override). Missing `override` when redefining an inherited open method diagnoses `Method 'B.F' is overridable; add 'override' to redefine it.`. Overriding a non-open method, mismatched signatures, or override of an unknown base all diagnose. Derived fields shadow base fields by name; inherited fields are bare-name accessible inside derived methods. Virtual dispatch routes `(base)d.F()` to the derived override at runtime on both backends. Emit lowers a class as a CLR reference type (TypeAttributes.Sealed when not `open`), BaseType pointing at the user base class TypeDef (else `System.Object`); methods are virtual+newslot+final by default, with `open` clearing Final, `override` clearing NewSlot, and `open override` clearing both; derived `.ctor` chains to the base `.ctor`. Forward base references are not supported — base must be declared before derived. |

## Expressions

| Expression | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| Integer / string / bool literal | ✅ | ✅ | ✅ | ✅ | Emitter literal table covers only `int`/`string`/`bool`. |
| Name | ✅ | ✅ | ✅ | ✅ | |
| Call `f(args)` | ✅ | ✅ | ✅ | ✅ | |
| Member access `a.b.c` | ✅ | ✅ | ✅ | ✅ | `AccessorExpressionSyntax`; resolves through `ReferenceResolver` to imported CLR types. |
| Parenthesized | ✅ | ✅ | ✅ | ✅ | |
| Assignment expression `x = e` | ✅ | ✅ | ✅ | ✅ | Identifier LHS only. |
| Indexing `a[i]` | ✅ | ✅ | ✅ | ✅ | Phase 3.A.3: read and write indexing on fixed-length arrays and slices via `IndexExpressionSyntax` and `IndexAssignmentExpressionSyntax`. Phase 3.A.4 extends to `map[K]V` (key-based; missing keys return the value type's zero value — the comma-ok form is deferred). Sliced reads (`a[lo:hi]`, `a[lo:hi:max]`) are not implemented. |
| Composite literal `[N]T{…}` / `[]T{…}` / `map[K]V{…}` | ✅ | ✅ | ✅ | ✅ | Phase 3.A.1: fixed-length array literal `ArrayCreationExpressionSyntax`; Phase 3.A.2 extends the same node to variable-length slice literals (length omitted). Phase 3.A.4 adds `MapCreationExpressionSyntax` lowered to `Dictionary[K,V]` — emit issues `newobj` + per-entry `set_Item`. |
| Built-in `len(x)` / `cap(x)` / `append(s, e)` / `delete(m, k)` | ✅ | ✅ | ✅ | ✅ | Phase 3.A.2: `len` on string/array/slice, `cap` on array/slice (aliases length per ADR-0016), `append` on slice (single trailing element only; variadic Go form deferred to Phase 4). Phase 3.A.4 extends `len` to `map[K]V` (emit: `callvirt get_Count`) and adds `delete(m, k)` (emit: `callvirt Remove`, pop bool). |
| Built-in `make(chan T)` / `make(chan T, cap)` | ✅ | ✅ | — | ✅ | Phase 5.4 / ADR-0022 (interpreter). `make` is contextual (not a keyword) — recognised when it precedes `(chan …)`. Capacity-less form lowers to `Channel.CreateUnbounded[T]()`; the capacity form lowers to `Channel.CreateBounded[T](new BoundedChannelOptions(cap))`. Emit deferred. |
| Built-in `close(ch)` | ✅ | ✅ | — | ✅ | Phase 5.4 / ADR-0022 (interpreter). Intrinsic — operand must be a `chan T`. Lowers to `ch.Writer.Complete()`. Subsequent receives drain buffered values, then return the element type's zero value. Emit deferred. |
| Type assertion / conversion (`x.(T)`, `T(x)`) | 🟡 | 🟡 | — | 🟡 | Built-in type names invoked as `int(x)` route through `BindCallExpression` → `BindConversion`; emit currently only handles bool↔int. Go-style `x.(T)` does not exist. |
| Address-of `&x` / dereference `*x` | 🟡 | ❌ | — | — | Parsed as unary, but no `BoundUnaryOperator` entry → binder rejects. The `Loop.gs` design sample's `*count` is **unimplementable today**. |
| Channel receive `<-ch` | ✅ | ✅ | — | ✅ | See "Send statement / receive" row above. Phase 5.5 / ADR-0022 (interpreter). |
| `switch` expression (`let x = switch v { case A -> r1 default -> r2 }`) | ✅ | ✅ | — | ✅ | Phase 6.1 expression form; Phase 6.2 case values now bind as patterns (constant, discard, type, property, relational, list). Phase 6.3 allows enum and sealed-interface discriminants to omit `default` when all variants are covered; non-exhaustive closed discriminants diagnose missing arms. Phase 6.6 ✅ narrows nullable discriminants inside type-pattern and non-nil constant-pattern arm results. Other discriminants still require `default`. Duplicate-covered variants are accepted; unreachable-arm analysis is deferred. All arm result expressions unify to a single type. Interpreter evaluates arms in source order; emit deferred. |
| Higher-order call `f()(args)` / function values | ✅ | ✅ | ✅ | ✅ | Phase 4.7 — first-class function types (`func(T) R`), indirect-call expressions, function-typed locals/params/returns. |
| Function literal / lambda | ✅ | ✅ | ✅ | ✅ | Phase 4.7 (`func(...) {...}` literal); Phase 4.9 adds Kotlin-style trailing-lambda call syntax — `f(args) func(...) {...}` desugars to `f(args, func(...) {...})` at parse time. |

## Patterns

| Pattern | Parser | Binder | Emit | Interp | Notes |
| --- | --- | --- | --- | --- | --- |
| Constant pattern (`case 1`) | ✅ | ✅ | — | ✅ | Legacy case expression spelling now wraps as `ConstantPatternSyntax`; equality uses `object.Equals` in the interpreter. Phase 6.6 ✅ narrows a nullable switch discriminant to its underlying type for non-`nil` constants. Emit deferred with pattern switch lowering. |
| Discard pattern (`case _`) | ✅ | ✅ | — | ✅ | Matches any discriminant value; top-level discard behaves like a lenient default arm. Emit deferred. |
| Type pattern (`case v is User`) | ✅ | ✅ | — | ✅ | Introduces read-only arm-local binding `v`; interpreter supports GSharp struct/class values and imported CLR instances. Phase 6.6 ✅ also narrows a nullable switch discriminant to the target type within that arm. Emit deferred. |
| Property pattern (`case { Name: "x" }`) | ✅ | ✅ | — | ✅ | Applies to GSharp struct/class discriminants; field values recurse into nested patterns. Emit deferred. |
| Relational pattern (`case > 0`) | ✅ | ✅ | — | ✅ | Operators bind through `BoundBinaryOperator`; `==` / `!=` are accepted. Emit deferred. |
| List pattern (`case [1, _, 3]`) | ✅ | ✅ | — | ✅ | Applies to arrays/slices with exact length matching; `..` slice patterns are deferred. Emit deferred. |

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
| Operator-by-name on user types (`func (p Point) plus`) | — | — | — | ❌ Phase 6.5 / ADR-0026 (deferred): a method named `plus` on a user type stays a regular method, not an implicit `op_Addition`. Re-opening criteria recorded in ADR-0026. |

Implicit and explicit conversions: `BindConversion` exists but the emitter (`EmitConversion`) currently implements **only** `int ↔ bool` round-trips. Any other conversion the binder considers legal (e.g., to/from imported CLR types, or the Phase-6-exit reference upcasts described next) will throw `NotSupportedException` at emit time. This is the largest binder/emit asymmetry in the codebase.

Reference upcasts (Phase 6 exit, added with `samples/aspirational/ExpressionEval.gs`): a `class` value implicitly converts to any interface it implements and to any of its (transitive) base classes. The interpreter treats the upcast as a no-op (the boxed instance keeps its concrete class identity), so `Lit{Value: 1}` flowing into an `Expr`-typed parameter or composite-literal field works end-to-end on the interpreter. Emit support for the upcast is deferred and shares the same posture as the rest of Phase 6.

## Top-line takeaways

1. **The dominant gap is parser → binder**, not binder → emit. The emitter implements essentially every bound node the binder can currently produce; failures show up as parser-rejections or binder "operator/conversion not supported" diagnostics.
2. **Two design samples already exceed the implementation.** `samples/Loop.gs` (pre-Phase-0 rewrite) and `design/Gsharp-design-v0.1.md` use C-style `for init; cond; post`, `args[0]` indexing, `i--`, and `*count` — none of which parse today. The Phase-0 rewrite of `samples/Loop.gs` removes those constructs; the v0.1 design Loop section is annotated as aspirational pointing at `design/Gsharp-design-v0.2.md`.
3. **String interpolation is real (Phase 1.1).** `"Count value: $i"` lexes as an `InterpolatedStringToken`, parses as `InterpolatedStringExpressionSyntax`, and lowers in the binder to a `+`-chain over `Convert.ToString` calls — emitted unchanged.
4. **The emitter caps literals at `int`/`string`/`bool`.** Adding any new literal kind (float, char/rune, null) requires coordinated lexer + binder + `EmitLiteral` changes.
5. **`int ↔ bool` is the only conversion path that emits.** Before adding numeric types or imported-type conversions to the binder, `EmitConversion` must be extended; otherwise valid programs will compile under the interpreter and crash the emitter.
6. **Phase 5 concurrency is interp-only by design.** Per ADR-0022 §Consequences and ADR-0023 §Emit, `go` / `chan` / `select` / `scope` / `async` / `await` / `await for` all show `—` in the Emit column; emit lands as a Phase-7 follow-up alongside the async state-machine decision (ADR-0027). The Phase-5 exit samples (`samples/aspirational/PortScan.gs`, `samples/aspirational/AsyncTask.gs`) demonstrate the surface end-to-end on the interpreter; `test/Core.Tests/LanguageConformance/AspirationalSamplesTests` runs them on every PR.
7. **Phase 6.1 switch expressions follow the same interp-only posture.** `switch` expressions parse, bind, and evaluate on the interpreter; emit remains deferred until expression lowering / codegen is designed for this surface.

## Phase 5 exit-criteria status (concurrency)

| Exit criterion | Status | Evidence |
| --- | --- | --- |
| Meaningful concurrent sample fan-out + fan-in + timeout | ✅ interp | `samples/aspirational/PortScan.gs` — chan + go + scope + select with timeout arm; covered by `AspirationalSamplesTests`. |
| Pure async/await sample interoperating with BCL `Task` | ✅ interp | `samples/aspirational/AsyncTask.gs` — `async func` + `await` against `Task.Delay`, driven from a top-level `scope { go ... }`. |
| Coverage matrix ✅ on the entire concurrency section | ✅ interp / ❌ emit | All concurrency rows above are ✅ at Interp; Emit is deferred per ADR-0022 / ADR-0023. |

**Open Phase-5 polish follow-ups** (carried into Phase 6/7):

- `HttpClient` end-to-end interop in a `.gs` sample requires (a) constructable imported types and (b) instance-member access on imported instances. Both are tracked as binder/symbol-table follow-ups; once they land, `AsyncTask.gs` will gain an `HttpClient`-using sibling and the exit row above is promoted from "BCL `Task`" to "BCL `HttpClient`".
- Two-value channel receive `v, ok := <-ch` (ADR-0022 §Open follow-ups).
- `ctx` source binding to expose a scope's CTS to user code (ADR-0022 §scope; deferred from #78).
- `break` / `continue` inside `await for` body (deferred from #79).
- Async-aware lowering of `await` and emit of state machines (Phase 7 / ADR-0027).

