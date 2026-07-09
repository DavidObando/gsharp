---
title: "Design decisions (ADRs)"
draft: false
---

# Design decisions (ADRs)

This is a curated reference index of the Architecture Decision Records in the repository. ADRs explain design intent and tradeoffs; they are not the normative language specification. Each link points to the source ADR on GitHub. The repository currently has accepted/proposed ADRs through **ADR-0146** (plus the `0000` template).

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
| [0050](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0050-trailing-arrow-lambda.md) | `->` arrow trailing-lambda syntax | Superseded by ADR-0074. The proposed `->`-connector trailing-lambda was never implemented and never will be — `->` is now the lambda operator, so the connector spelling collides with `(params) -> …` lambdas. Full arrow lambdas plus the live Phase 4.9 `func(...)` trailing-call form cover the need (revisited under issue #411). |
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
| [0128](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0128-arrow-lambda-statement-block-parity.md) | Arrow-lambda / func-literal parity — statement-block arrow bodies | A block-bodied arrow lambda `(p) -> { … }` becomes a statement block with an optional trailing value expression: an `if`-without-`else` (and other void control-flow) is a void statement instead of being rejected with `GS0276`, reaching full parity with `func` literals. The parser classifies `if` as a value-producing if-expression only when it has a matching `else`. cs2gs reverts the #1160 workaround and emits idiomatic arrow lambdas for block-bodied C# lambdas. |
| [0129](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0129-numeric-literal-narrowing-widening.md) | C#-compatible numeric literal narrowing/widening | A constant integer expression (an integer literal, or unary `+`/`-` over one) implicitly narrows to any integer target whose range contains its value (C# §10.2.11), so `var x uint8 = 42` / `var a int8 = -5` compile with no cast; out-of-range constants still error (`GS0156`). Non-constant values widen implicitly per the lattice and narrow only via the explicit `T(x)` conversion-call form (truncating like C#). |

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
| [0059](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0059-named-delegate-types.md) | Named delegate types | `type Name = delegate func(...)` declares a real CLR `MulticastDelegate`-derived type; generic delegates supported per issue #1503; diagnostic `GS0233`. |
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

## 0.3 ADRs (0105-0146)

The 0.3 documentation audit covers these ADRs landed after the 0.2 snapshot. The earlier curated sections above remain grouped by topic; this table keeps the current ADR range visible.

| ADR | Title |
| --- | --- |
| [0105](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0105-incremental-delta-binding-language-server.md) | Incremental (delta) binding for the language server |
| [0106](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0106-incremental-semantic-model-language-server.md) | Incremental LSP SemanticModel via instance-keyed memoization |
| [0107](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0107-cross-session-cold-start-cache-language-server.md) | Cross-session cold-start cache for the language server |
| [0108](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0108-delegate-return-type-covariance.md) | Delegate return-type covariance and lambda target-typing on CLR method calls |
| [0109](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0109-top-level-private-accessibility.md) | Top-level `private` maps to IL `assembly` (internal) |
| [0110](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0110-nested-type-declarations.md) | Nested type declarations |
| [0111](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0111-completion-as-you-type-language-server.md) | Completion-as-you-type triggering policy |
| [0112](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0112-unified-member-resolution.md) | Unified member resolution |
| [0113](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0113-predefined-alias-static-member-receiver.md) | Predefined type aliases as static-member-access receivers |
| [0114](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0114-nested-class-constructor-emission.md) | Nested (and forward-referenced) class constructor emission |
| [0115](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0115-csharp-to-gsharp-migration-tool.md) | `cs2gs` — a C#→G# migration tool and gap-discovery pipeline |
| [0116](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0116-null-coalescing-operator-spelling.md) | Null-coalescing operator spelled `??` (replacing `?:`) |
| [0117](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0117-collection-initializers.md) | Collection initializers — `List[T]{…}`, `HashSet[T]{…}`, `Dictionary[K,V]{…}` |
| [0118](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0118-user-indexer-member-declaration.md) | User indexer-member declaration — `prop this[i int32] T { get; set }` |
| [0119](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0119-canonical-arrow-lambda-inference.md) | Inferred-type arrow lambdas are the canonical lambda form |
| [0120](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0120-user-conversion-operators.md) | User-defined conversion operators (`operator implicit` / `operator explicit`) |
| [0121](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0121-throw-expressions.md) | Throw expressions (`throw` in value position) |
| [0122](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0122-unsafe-context-unmanaged-pointers.md) | Unsafe context and unmanaged raw pointers (`*T` = `ELEMENT_TYPE_PTR`) |
| [0123](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0123-from-end-index-operator.md) | From-end index operator (`^n`) for index and range bounds |
| [0124](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0124-stackalloc-localloc.md) | `stackalloc [n]T` stack allocation (`localloc`) — safe `Span<T>` and unsafe `T*` forms, with initializers |
| [0125](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0125-fixed-pinned-statement.md) | `fixed` statement — pinning a managed buffer and binding an unmanaged `*T` |
| [0126](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0126-increment-decrement-expressions.md) | Increment / decrement as value-producing expressions (`++` / `--`) |
| [0127](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0127-standalone-range-value.md) | Standalone `System.Range` value (`let r = 1..3`) |
| [0128](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0128-arrow-lambda-statement-block-parity.md) | Arrow-lambda / func-literal parity — statement-block arrow bodies |
| [0129](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0129-numeric-literal-narrowing-widening.md) | C#-compatible numeric literal narrowing/widening |
| [0130](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0130-runtime-array-allocation.md) | `[n]T` runtime/zero-initialised array allocation |
| [0131](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0131-expression-bodied-members.md) | Expression-bodied members via the `->` arrow |
| [0132](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0132-nullable-array-element-spelling.md) | `[]T?` array of nullable elements vs `[]?T` nullable array |
| [0133](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0133-implicit-numeric-promotion-call-sites.md) | Implicit numeric promotion at call sites |
| [0134](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0134-static-imports-using-static.md) | Static imports — `import Ns.Type` exposes `shared` members for unqualified use (C# `using static`) |
| [0135](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0135-unmanaged-constraint-and-sizeof.md) | `unmanaged` type-parameter constraint and `sizeof(T)` expression |
| [0136](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0136-nullable-by-default-for-unannotated-imports.md) | Unannotated imported reference types are nullable by default |
| [0137](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0137-nullable-function-type-spelling.md) | Nullable function type spelling |
| [0138](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0138-cs2gs-construct-coverage-and-gap-triage.md) | cs2gs construct-coverage program and gap-triage automation |
| [0139](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0139-goto-and-general-labels.md) | general `goto` / label statements |
| [0140](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0140-shared-static-initializer-block.md) | `shared { init { … } }` static-initializer block |
| [0141](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0141-expression-tree-lambda-conversions.md) | lambda conversions to `Expression[TDelegate]` |
| [0142](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0142-resx-codebehind-generator.md) | resx codebehind generator (`Resources.Designer.gs`) |
| [0143](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0143-source-generators-in-cs2gs-migration.md) | generated code in cs2gs migration — reproduce at build, don't freeze |
| [0144](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0144-partial-types.md) | partial types (`partial` on class / struct / interface) |
| [0145](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0145-source-generator-host-native-gsharp.md) | Roslyn source-generator host for native G# projects (`gsgen`) |
| [0146](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0146-anonymous-class-literal.md) | Anonymous-object literal (`object { ... }`, Kotlin-style) |
