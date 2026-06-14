---
title: "Design decisions (ADRs)"
draft: false
---

# Design decisions (ADRs)

This is a curated reference index of the Architecture Decision Records in the repository. ADRs explain design intent and tradeoffs; they are not the normative language specification. Each link points to the source ADR on GitHub.

## Null model, values, and primitives

| ADR | Title | Summary |
| --- | --- | --- |
| [0001](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0001-null-model.md) | Absence / null model — Kotlin-style nullable types | Uses explicit nullable `T?`, `nil`, safe access, and assertion instead of a universal null. |
| [0073](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0073-null-conditional-indexing.md) | Null-conditional indexing `a?[i]` | Adds the `?[` token; result lifts to the nullable form of the indexer's return type; receiver evaluated exactly once; rejected as assignment LHS. |
| [0008](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0008-variable-bindings.md) | Variable bindings — keep Go's `var`/`const`/`:=`, add `let` | Original decision; the `:=` short-declaration leg was superseded by ADR-0077. |
| [0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md) | Drop `:=` short variable declaration | Removes `:=` from the language; the parser hard-rejects it with `GS0305` and a context-sensitive `let`/`var`/`for … in …` migration suggestion. |
| [0015](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0015-multi-target-assignment.md) | Multi-target assignment evaluation order | Evaluates all right-hand values before observable writes, matching Go swap semantics. |
| [0016](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0016-slice-storage.md) | Slice backing storage — `T[]` | Represents slices with CLR single-dimensional zero-based arrays. |
| [0044](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0044-numeric-primitive-coverage.md) | Complete numeric primitive coverage | Defines full width-bearing numeric primitive coverage and conversion behavior. |
| [0045](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0045-object-universal-upper-bound.md) | `object` as the universal upper bound | Makes `object` the top type for assignment compatibility, boxing, and object equality. |
| [0046](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0046-char-literal-grammar.md) | `'c'` character literal grammar | Specifies character literal grammar, escapes, static type, and diagnostics. |
| [0049](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0049-width-bearing-integer-names.md) | Width-bearing integer keyword names | Chooses explicit names such as `int32` and `uint64` over ambiguous aliases. |
| [0098](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0098-friendly-numeric-type-aliases.md) | Friendly numeric type aliases | Adds `int` / `uint` / `long` / `ulong` / `short` / `ushort` / `byte` / `sbyte` / `float` / `double` as binder-resolved aliases on top of the canonical width-bearing names; diagnostics and IL keep the canonical spelling. |

## Concurrency, async, and resource scope

| ADR | Title | Summary |
| --- | --- | --- |
| [0002](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0002-concurrency-model.md) | Concurrency model — Go surface, .NET runtime, Kotlin scopes | Combines Go-like `go`/channel syntax with .NET tasks and structured scopes. |
| [0022](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0022-go-chan-select-lowering.md) | `go` / `chan` / `select` → .NET lowering | Defines how goroutine-like calls, channels, send/receive, and select lower to .NET. |
| [0023](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0023-async-state-machine.md) | `async func` / `await` — state-machine strategy | Commits to compiler-generated async state machines for emitted async functions. |
| [0030](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0030-defer-and-using-block-scope.md) | `defer` and block-scoped cleanup convergence | Makes cleanup block-scoped and aligns `defer` with using/finally lowering. |
| [0040](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0040-sequence-type-and-yield.md) | `sequence[T]` type alias and `yield` statement | Introduces sequence types and iterator `yield` statements. |
| [0041](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0041-async-sequence-alias.md) | `sequence[T]` in an `async` context aliases `IAsyncEnumerable[T]` | Explores async sequence feasibility and binding shape. |
| [0042](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0042-async-sequence-type-clause.md) | `async sequence[T]` as a type-clause spelling for `IAsyncEnumerable[T]` | Chooses an explicit type-clause spelling for async streams. |
| [0043](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0043-async-func-type-clause.md) | `async func(P) R` as a type-clause spelling for `func(P) Task[R]` | Defines async function type clauses as task-returning function types. Re-spelled as `async (P) -> R` by ADR-0075. |

## Object model, OO, and data types

| ADR | Title | Summary |
| --- | --- | --- |
| [0003](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0003-oo-surface.md) | OO surface — data-oriented core with light OO escape hatch | Adds classes/interfaces without making OO the center of the language. |
| [0017](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0017-method-virtuality.md) | Method virtuality — sealed by default, opt-in with `open` | Requires explicit `open` for inheritable classes and overridable methods. |
| [0018](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0018-interface-defaults.md) | Interface default methods — not in Phase 3 | Defers default interface methods from the early interface surface. |
| [0024](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0024-methods-vs-extensions-canonical-style.md) | Methods with receivers vs. extension functions canonical style | Establishes receiver functions as the canonical extension/method style. |
| [0079](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0079-restrict-receiver-clauses-to-non-owned-types.md) | Restrict receiver-clause methods to non-owned receiver types (warning) | Reserves `func (r T) M()` for types the package does not own; same-package owned receivers emit the soft `GS0314` warning. Operators are exempt. |
| [0025](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0025-record-keyword-alias.md) | `record` keyword alias for `data struct` | Makes `record` syntactic sugar for `data struct`. |
| [0029](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0029-data-struct-synthesized-members.md) | `data struct` synthesized members | Defines synthesized equality, copy, and ergonomic members for data structs. |
| [0032](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0032-data-struct-ergonomics.md) | Data-struct ergonomics polish | Refines copying, deconstruction, and update syntax for data structs. |
| [0033](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0033-inline-value-classes.md) | Inline value classes / `inline struct` | Introduces single-field inline structs for value-class ergonomics. |
| [0051](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0051-property-declarations.md) | Property declarations — `prop` keyword with accessor bodies | Specifies property syntax, auto-properties, and accessors. |
| [0052](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0052-event-declarations.md) | Event declarations on user types — `event` keyword | Defines field-like and custom event declarations on user types. |
| [0053](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0053-static-members.md) | Static members on user types — `shared` block | Adds static fields, methods, properties, and events through a `shared` block. |

## Generics and functions

| ADR | Title | Summary |
| --- | --- | --- |
| [0004](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0004-generics-scope.md) | Generics — consumption and definition in a single phase, with constraints | Defines initial generic types/functions, constraints, and reified-CLR-generics commitment (now fully delivered; the original implementation-status addendum was superseded by ADR-0087 R1–R7). |
| [0020](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0020-generic-brackets.md) | Generic type-parameter brackets — Go-style `[T]` | Chooses square brackets for type parameters and type arguments. |
| [0021](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0021-generic-variance.md) | Generic variance modifiers — `in` / `out` on interface type parameters | Adds variance markers for interface type parameters. |
| [0038](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0038-generic-method-inference.md) | Type-argument inference for imported open generic methods | Defines inference for imported generic method calls and associated emit fixes. |
| [0050](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0050-trailing-arrow-lambda.md) | `->` arrow trailing-lambda syntax | Proposed shorthand for trailing lambdas; not part of the current implemented grammar. |
| [0087](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0087-reified-generics-emit-audit.md) | Reified-generics emit — open-shape erasure audit, staged elimination plan, and v1 disposition | Implementation-status addendum to ADR-0004. Catalogued every open-generic erasure site (53 across 14 source files), specified the target CLR metadata (`TypeDef`+`GenericParam`, `TypeSpec`/`MethodSpec`, `Var`/`MVar` encoding), staged the elimination R1–R7 (all implemented), and pinned the v1 disposition. Supersedes issue #484. |

## Error handling and control flow

| ADR | Title | Summary |
| --- | --- | --- |
| [0005](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0005-error-handling.md) | Error handling — exceptions only, unchecked | Uses CLR exceptions instead of checked exceptions or Go-style error returns. |
| [0009](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0009-switch-semantics.md) | `switch` semantics — expression + statement, patterns, exhaustive | Defines switch statements, switch expressions, patterns, and exhaustiveness. |
| [0013](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0013-no-fallthrough.md) | Drop Go's `fallthrough` | Reserves `fallthrough` but rejects it; cases never fall through. |
| [0031](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0031-canonical-for-in.md) | Canonical `for x in collection` | Establishes `for x in collection` as the preferred range iteration spelling. |

## Syntax, naming, and documentation policy

| ADR | Title | Summary |
| --- | --- | --- |
| [0006](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0006-visibility.md) | Visibility — explicit modifiers, `public` default | Replaces Go capitalization export rules with explicit visibility modifiers. |
| [0007](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0007-string-interpolation.md) | String interpolation syntax — Kotlin-style | Chooses `$name` and `${expr}` interpolation forms. |
| [0010](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0010-aspirational-samples.md) | Aspirational samples policy — rewrite to today's subset, re-expand per phase | Keeps samples aligned with implemented language phases. |
| [0011](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0011-string-interpolation-grammar.md) | String interpolation grammar and lowering | Specifies interpolation parsing and lowering details. |
| [0012](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0012-raw-string-delimiter.md) | Raw string delimiter — backtick | Chooses backtick-delimited raw strings. |
| [0014](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0014-visibility-default.md) | Visibility defaults — `public` for top-level declarations | Makes unmodified top-level declarations public by default. |
| [0054](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0054-postfix-member-access-on-primary-expressions.md) | Postfix member/index access on primary expressions | Chains `.`/`?.`/`[]` after any primary except a bare numeric literal (`(42).Member`). |
| [0055](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0055-string-interpolation-revamp.md) | String interpolation revamp | Delimiter-aware multiline holes, alignment/format clauses, late context-driven lowering (`DefaultInterpolatedStringHandler`/`FormattableString`), and full IDE support inside holes. |
| [0057](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0057-documentation-comments.md) | Documentation comments | Markdown-authored `///` documentation comments with lossless CLR XML-doc round-trip; hover renders the merged XML on imported APIs. Diagnostics `GS0227`–`GS0231`. |
| [0062](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0062-generalized-ternary-expression.md) | Generalized ternary expression | Promotes `cond ? a : b` from the narrow ADR-0061 ref form to a normal expression; retires `GS0259` in value contexts and adds `GS0263`. |
| [0074](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0074-arrow-lambda-and-colon-switch-arms.md) | `->` for lambda expressions, `:` for switch-expression arms | Adds the arrow-lambda expression form `(x int32) -> x * x` and migrates switch-expression arms from `->` to `:` (deprecated old arm form emits `GS0302`). |
| [0075](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0075-arrow-function-type-clause.md) | `(T) -> R` as the canonical function-type clause syntax | Function-type clauses are spelled `(T1, T2) -> R` and `async (T) -> R`. The legacy `func(T) R` and `async func(T) R` type-clause spellings stay valid for one release and emit `GS0303`. |
| [0076](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0076-lambda-binding-type-inference.md) | Type inference for `let` / `var` lambda bindings | When a `let` / `var` binding is initialized with a lambda whose parameter types are fully spelled, the binding's type is inferred to the lambda's `(T1, ...) -> R` function type. Open lambdas (untyped params and no target type) emit `GS0304`. |

## CLR interop

| ADR | Title | Summary |
| --- | --- | --- |
| [0019](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0019-extension-functions.md) | Extension function declaration syntax — `func (Receiver) Name(...) ...` | Defines receiver-based extension function syntax. |
| [0026](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0026-operator-by-name-deferral.md) | Operator-by-name on user types — deferred | Defers user operator naming until a later design is chosen. |
| [0034](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0034-imported-clr-interop.md) | Imported CLR interop — static members, writes, operators, conversions, overload resolution | Extends imported CLR support across static members, writes, operators, conversions, and overloads. |
| [0035](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0035-user-operator-overloads.md) | User-defined `operator` keyword on GSharp types | Adds receiver-style operator declarations for G# types. |
| [0036](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0036-event-subscription.md) | CLR event subscription with `+=` / `-=` | Uses assignment-like syntax for CLR event add/remove. |
| [0037](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0037-numeric-tiebreaking.md) | Numeric better-conversion target tie-breaking in overload resolution | Defines numeric conversion ranking for overload resolution. |
| [0039](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0039-byref-pointers-and-clr-interop.md) | By-ref pointers and CLR interop for `ref` / `out` / `in` parameters | Introduces `*T`, `&`, dereference, `ref` arguments, and related diagnostics. |
| [0047](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0047-attribute-syntax-and-declaration.md) | Attribute consumption and declaration (Kotlin-style annotations) | Defines `@` annotation syntax, use-site targets, attribute arguments, and `@Attribute` sugar. |
| [0056](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0056-span-consumption-v1.md) | Span consumption v1 — ref-returning members, span element access, closed generic value-type fields | Auto-dereferences ref-returning members in rvalue position, makes spans indexable (read/write), applies `[]T → Span[T]` conversion in argument position, and gives closed generic value-type fields real layout. |
| [0058](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0058-ref-safe-to-escape.md) | Ref-safe-to-escape and the `scoped` modifier | Adds the `scoped` parameter modifier and the supporting `GS9004`/`GS9006` ref-pointer escape diagnostics. |
| [0059](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0059-named-delegate-types.md) | Named delegate types | `type Name = delegate func(...)` declares a real CLR `MulticastDelegate`-derived type; diagnostics `GS0233`–`GS0234`. |
| [0060](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0060-ref-out-in-parameters.md) | `ref`/`out`/`in` parameters | Declaration-site and call-site ref-kind modifiers with diagnostics `GS0235`–`GS0243`; ref-aliasing locals (`let ref`/`var ref`) and ref returns are follow-ups (`GS0248`–`GS0258`). |
| [0061](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0061-conditional-ref-arguments.md) | Conditional ref-arguments | Narrow `ref cond ? a : b` form inside ref-kind argument payloads; diagnostics `GS0259`–`GS0262`. |
| [0063](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0063-method-overloading-and-optional-parameters.md) | Method overloading and optional parameters | Lifts the v0 "one declaration per name" rule and adds default parameter values; diagnostics `GS0264`–`GS0267`. |
| [0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md) | Deprecate `name = value` named-argument spelling (warning) | Reserves `name: value` as the canonical call-site and attribute named-argument separator (issue #343); the legacy `=` spelling kept for back-compat by ADR-0032 / ADR-0047 emits the soft `GS0315` warning before removal. |

## Emit and tooling

| ADR | Title | Summary |
| --- | --- | --- |
| [0027](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0027-roslyn-fork-decision.md) | Roslyn-fork decision for v1.0 — stay on the bespoke emitter | Keeps the direct metadata emitter instead of adopting a Roslyn fork for v1.0. |
| [0028](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0028-multi-package-emit.md) | Multi-package emit model — Option B, C#-faithful | Defines how multiple packages map to emitted CLR namespaces/types. |
| [0048](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0048-portable-pdb-emit.md) | Portable PDB emit | Adds portable PDB, source mapping, and debug-symbol policy to the emitter. |
