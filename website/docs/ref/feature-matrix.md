---
title: "Feature matrix"
sidebar_position: 4
draft: false
---

# Feature matrix

This matrix summarizes current feature support in the emitter, which every driver uses. The historical evaluator column is retained to explain older tests; that backend and its command-line selection have been removed. Legend: **Supported** means implemented on that path; **Mostly supported** means ordinary cases work with known edge limitations; **Partial** means syntax or binding exists but execution or emit is incomplete; **Not supported** means rejected or intentionally absent; **N/A** means the feature belongs to tooling rather than one execution path.

## Lexical and source structure

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| Lexing, parsing, keywords, tokens, literals | Supported | Supported | Shared lexer and parser. |
| Packages, imports, import aliases | Supported | Supported | Emit supports multi-package assemblies; both backends shared the same binder. |
| Implicit `System` import | Supported | Supported | Enabled by default; disabled with `/noimplicitimports` or `/no-implicit-imports`. |
| Top-level statements and `func Main` | Supported | Supported | Mixing top-level statements and explicit `Main` is diagnosed by `GS0165`/`GS0166`. |
| Comments | Supported | Supported | Line (`//`), block (`/* … */`), and Markdown documentation (`///`) comments. |
| String, raw string, and interpolated string literals | Supported | Supported | Sigil-free interpolation with `$name`/`${expr,alignment:format}`, delimiter-aware multiline holes, and `DefaultInterpolatedStringHandler`/`FormattableString` lowering. |
| Character literals | Supported | Supported | Character diagnostics are `GS0191` through `GS0195`. |
| Documentation comments | Supported | Supported | `///` Markdown comments round-trip to CLR XML doc; hover renders CLR XML docs for imported APIs. Diagnostics `GS0227`–`GS0231`. |

## Types and values

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| Primitive types and numeric operators | Supported | Mostly supported | The evaluator implemented primitive arithmetic; address/deref unary operators were limited. |
| Width-bearing integer names | Supported | Supported | Canonical names are `int32`, `uint64`, and related widths. Friendly aliases are also accepted: `int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, and `double`; they resolve to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, hover, and IL print the canonical name. |
| Numeric conversions | Supported | Supported | Widening numeric conversions plus explicit conversions. |
| `object` universal upper bound | Supported | Supported | Boxing and object equality are implemented. |
| Nullable `T?`, `nil`, `!!`, `??`, `?.`, `?[i]` | Supported | Supported | The evaluator threw on a nil `!!`; `?[i]` short-circuited indexing to `nil` when the receiver was nil. |
| Arrays and slices | Supported | Supported | Slices are CLR arrays (`[]T` is `T[]`): length is `.Length`; the growable shape is `List[T].Add`. The Go-style `len` / `cap` / `append` built-ins are retired (ADR-0174, GS0566 names the replacement). |
| Maps | Supported | Supported | Backed by `Dictionary[K,V]`: `.Remove(k)` and `.Count` are the members (the Go-style `delete` / `len` built-ins are retired, ADR-0174). Iterable with range `for`: `for k, v in m` destructures entries, `for kv in m` yields `KeyValuePair[K,V]`; order unspecified. |
| Tuples and multi-return | Supported | Supported | Multi-value return syntax is represented as tuple literals. Tuple `==` / `!=` compare element-wise with short-circuit, single-evaluation semantics (ADR-0171). Named elements `(line int32, column int32)` / `(line: 1, column: 2)` resolve positionally; names are metadata (ADR-0172). |
| Struct literals | Supported | Supported | Field initialization and field access are implemented. |
| Data classes, data structs, `with`/copy | Supported | Supported | `data class` (reference) and `data struct` (value) synthesise equality, `with`-copy, and deconstruction. The `record` keyword is not supported; migrate to `data struct` (preserves value semantics) or `data class` (reference semantics). |
| Inline structs | Supported | Supported | Exactly one field; participates in structural equality. |
| Classes and primary constructors | Supported | Partially supported | The evaluator supported G# classes, with limited CLR base-initializer modeling. |
| Explicit class `init` constructors | Supported | Supported | G# class constructors are parsed, bound, and evaluated. |
| Interfaces | Supported | Supported for checking/upcasts | Default-interface methods, static-virtual interface members declared inside the interface's `shared { … }` block, `private` interface helper methods — instance helpers in the interface body, static helpers as `private func` inside the interface's `shared { … }` block — and the explicit-base interface call syntax `base[IFoo].M(...)` for DIM diamond disambiguation are supported. |
| Properties | Supported | Supported | Auto/computed and static/shared forms are represented. |
| Events | Supported | Supported | G# and CLR event subscription paths exist. |
| Static/shared members | Supported | Supported | Declared in a `shared { ... }` block. |
| Function types, literals, closures | Supported | Supported | Delegate conversions are strongest on the emit path. |
| Generics and method inference | Supported | Supported for binding/evaluation | Reified CLR generics: user-declared generic types/methods emit `GenericParam` rows; signatures over `T` encode `Var`/`MVar`; closed CLR generics over an in-scope type parameter (`List[T]`) emit honest `GenericInstantiation` blobs; open-bearing delegates (`func(T) U`) dispatch through `Func`N::Invoke` MemberRefs on constructed `TypeSpec`. |
| Variance and constraints | Supported semantically | Supported semantically | Diagnostics include `GS0150` through `GS0153`. |
| By-ref and pointers | Partial | Limited/not supported | `&` / `*` / `*T` for CLR `ref`/`out`/`in` interop; ref returns auto-dereference in rvalue position. The evaluator rejected generic address/deref execution. |
| `ref`/`out`/`in` parameters | Supported | Supported | Declaration-site and call-site modifiers; diagnostics `GS0235`–`GS0243`. Includes `out var/let/_` inline declarations. |
| Ref-aliasing locals (`let ref` / `var ref`) | Supported | Supported | Local whose IL slot is `T&` and aliases another lvalue. Diagnostics `GS0256`–`GS0258`. |
| `ref`-returning functions | Supported | Supported | `func f(...) ref T { ... }` paired with `return ref <lvalue>`. Diagnostics `GS0248`–`GS0255`. |
| `scoped` parameter modifier | Supported | Supported | Constrains a `ref struct` / managed-pointer parameter from escaping; enforced by `GS9004` / `GS9006`. |
| Spans and `ref struct` types | Mostly supported | Limited | Stack-only consumption of `Span[T]` / `ReadOnlySpan[T]` and user `ref struct X`: element read/write, `[]T`→span conversion, closed generic value-type fields. Escape rules are `GS0219`; `ReadOnlySpan[T]` writes are `GS0226`. Full ref-safe-to-escape analysis is not implemented. |

## Declarations and members

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| Top-level functions and variables | Supported | Supported | `var`, `let`, and `const` are implemented. The legacy `:=` short variable declaration is not supported; the parser hard-rejects it with `GS0305`. |
| Visibility modifiers | Supported | Supported | `public`, `internal`, and `private`; invalid locations report `GS0180`. |
| Receiver methods and extension functions | Supported | Supported | G# receiver style and imported CLR extension dispatch. The inferred receiver-clause form warns (`GS0314`) when it targets an owned class or struct; `func extension (r T) M()` explicitly declares an extension for enum/owned receivers. In-body declarations remain canonical for real owned-type methods. |
| Operator declarations | Supported | Supported where the evaluator invoked user/CLR op paths | Receiver and in-body `operator` declarations map to CLR `op_*` names. In-place compound operators such as `operator +=` are void instance members with one operand and take precedence over binary fallback. |
| Interface implementation | Supported | Supported for checks/upcasts | Missing members and sealed-interface violations are diagnosed. Explicit qualifier clauses (`func (IFoo) M`, `prop (IFoo) P`, `event (IFoo) E`) support distinct method/property/indexer/event implementations and static interface members. |
| Inheritance and overrides | Supported | Partially supported | Base classes must be `open`; override diagnostics are implemented. |
| Default parameter values in G# declarations | Supported | Supported | Optional parameters carry compile-time-constant defaults; rule violations report `GS0265`. |
| Method overloading (user functions) | Supported | Supported | Functions can carry overload sets differing by parameter types, ref-kinds, or generic-parameter constraints (`where T : class` / `where T : struct`); duplicates report `GS0264`, ambiguous calls report `GS0266` or `GS0160`, no-applicable reports `GS0267`. |
| Variadic parameters (`name ...T`) | Supported (all declaration sites) | Supported (all declaration sites) | Canonical Go-style spelling `name ...T`; body sees `[]T`; at most one variadic per signature and must be last (`GS0145`, `GS0364`). Call site packs N trailing args into a fresh `[]T`; a single trailing `[]T` argument passes through unwrapped (identity preserved). The emitter stamps `[System.ParamArrayAttribute]` so C# / F# / VB consumers see it as `params T[]`. The C# `params` keyword is rejected with `GS0363` pointing at the canonical form. Accepted on top-level `func`, class instance/static methods, interface methods (incl. default-body), constructors, lambdas, and named delegate declarations. |
| Named delegate types | Supported | Supported | `delegate X(...) ` declares a real CLR `MulticastDelegate`-derived type;; generic delegates (`delegate X[T any](...) `) supported;; diagnostic `GS0233`. |

## Statements and control flow

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| `if` | Supported | Supported | Includes simple-statement form. The `if let name = expr { ... } [else { ... }]` binding form strips a nullable layer and narrows `name` to the underlying type inside the then-branch. `if` is also available as a value-producing expression — see the *If expression* and *`if let` expression* rows below. |
| `if` expression | Supported | Supported | `let x = if cond { a } else { b }` and `else if` chains in value position. Requires a terminal `else` (`GS0276`); blocks must end in a value-producing expression (`GS0277`); branches with no common type report `GS0263` (shared with the ternary). Lowers through the same `BoundConditionalExpression` / `BoundBlockExpression` nodes the ternary and switch expression use. |
| `if let` expression | Supported | Supported | `if let a = e [, let b = e2]* [&& guard] { value } else { value }` in value position. Terminal `else` required; bindings short-circuit left-to-right and are visible in later initializers, the guard, and the then-branch only. A top-level `&&` after the last binding delimits the optional `bool` guard (parenthesize a logical-and that belongs to an initializer). Same `GS0276` / `GS0277` / `GS0263` branch rules as the `if` expression, plus `GS0296` for a non-nullable initializer. Lowers through the same `BoundConditionalExpression` / `BoundBlockExpression` nodes. |
| `guard let` | Supported | Supported | `guard let name = expr else { ... }` binds `name` for the remainder of the enclosing block and requires the else clause to unconditionally exit (`GS0297`). |
| `for` condition, clause, infinite loops | Supported | Supported | Companion `while` and `do`-`while` forms are supported. |
| `for x in collection` | Supported | Supported | Canonical `in` form over arrays, slices, strings, sequences, CLR enumerables, and `map[K,V]` (`for k, v in m` destructures entries; `for kv in m` yields `KeyValuePair[K,V]`; iteration order unspecified). The legacy `for x := range collection` Go-style spelling is not supported. |
| Ellipsis loops | Supported | Supported | `for i in start ... end`. The legacy `for i := start ... end` spelling is not supported. |
| `while`, `while let`, and `do`-`while` | Supported | Supported | `while cond { ... }` (boolean pre-test), `while let name = nullableExpr { ... }` (body-scoped nullable binding re-evaluated before each iteration), and `do { ... } while cond` (post-test). |
| `break` and `continue` (with optional loop labels) | Supported | Supported | Invalid locations are diagnosed. Loop labels (`label: for ...`, `break label`, `continue label`) are supported; diagnostics `GS0293`–`GS0295`. |
| Multi-assignment and deconstruction | Supported | Supported | Multi-assignment accepts locals, inline `let`/`var` bindings, fields, properties, arrays, maps, CLR indexers, nested member targets, pointer dereferences, and a tuple-valued single RHS. Tuple declarations support both `let (a, b)` and `var (a, b)`. Target components evaluate before RHS values; writes/declarations occur left-to-right. Arity and invalid-target diagnostics are `GS0167` and `GS0526`. |
| Null-coalescing compound assignment (`??=`) | Supported | Supported | `a ??= b` writes `b` only when `a` reads as `nil`; RHS short-circuits otherwise. Receiver and index expressions evaluated exactly once. Works on locals, fields, properties, and indexers. Non-nullable LHS reports `GS0298`; non-assignable LHS reports `GS0299`. |
| `switch` statements | Supported | Supported | Cases do not fall through. Flow analysis narrows the discriminator inside type-pattern arms (`case d is T`) and lifts a common narrowing into the rest of the enclosing block when the switch is exhaustive and every non-exiting arm contributes the same narrowing. |
| Switch expressions | Supported | Supported | Exhaustiveness and arm type diagnostics implemented. |
| Patterns | Supported | Supported | Constant, relational, type, property, list/rest, discard, total `var name`, parenthesized, and `not` / `and` / `or` patterns work in switches and boolean `is`; type-plus-property patterns narrow composed `and` operands. A designation after a type, type-plus-property, property, or slice pattern (`value is string text`, `{ Length: > 0 } text`, `[..rest]`) introduces a read-only pattern variable scoped to the regions where the match is known to have happened. `var name` always matches and binds the exact static input type, including nullable values (ADR-0166). |
| `fallthrough` | Not supported | Not supported | Reserved and diagnosed as `GS0168`. |
| `try`, `catch`, `finally`, `throw` | Supported | Supported | CLR exception model. |
| `using` | Supported | Supported if lowered/bound disposable | Resource-scope variable declaration. |
| `defer` | Supported by binding/lowering intent | Supported when lowered before evaluation | Binder requires a call expression. |
| `goto` | Supported | Supported | `label: statement` and `goto label` support forward references and outward jumps; entering a nested block or exception handler is rejected. |

## Expressions

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| Calls and generic calls | Supported | Supported | Bracketed type arguments. |
| Named arguments | Supported | Supported | `Foo(timeout: 30, retries: 3)` for free functions, user methods/constructors, extension functions, and inherited CLR methods (including delegate `Invoke`). Named arguments use `:`; `=` is an ordinary assignment expression and an ambiguous bare assignment warns with `GS0524`. Indirect calls through a function-typed variable and variadic targets are excluded. |
| Conditional (`?:`) ternary expression | Supported | Supported | `cond ? a : b` is a normal expression. `GS0263` covers the "no common type" failure. |
| General block expressions | Supported | Supported | `{ statements... trailingExpression }` works in any expression position, with lexical scope, target typing, async/iterator spilling, and exactly-once evaluation. Missing tail: `GS0277`; expression trees: `GS0473`. |
| Conditional ref-arguments (`ref cond ? a : b`) | Supported | Supported | Branches must produce same-typed lvalues. Diagnostics `GS0260`–`GS0262`. |
| Struct, array, map, and collection literals | Supported | Supported | Array/slice and CLR collection initializers accept `...source` spread elements, evaluated once in lexical order with per-element conversion. Named object literals accept one leading spread for explicit structural projection. |
| Structural projection | Supported | Supported | Compatible public fields/properties can implicitly project into a safely constructible concrete target. `Target{ ...source, Member: override }` makes projection explicit; required constructor inputs must be supplied and explicit entries win. |
| Indexing and index assignment | Supported | Supported | Arrays, slices, maps, and imported CLR indexers. |
| Null-conditional access | Supported | Supported | `?.` and `?[i]` are represented in the bound tree. `?[i]` covers arrays, slices, maps, and CLR indexers; non-nullable receiver warns `GS0300`; `?[i]` rejected as assignment LHS (`GS0301`). |
| Type operators | Supported | Supported | `typeof(...)` and `nameof(...)`. |
| `default(T)` and bare `default` literal | Supported | Supported | `default(T)` for any type expression; bare `default` valid in target-typed positions (`let`/`var` with explicit type, `return` with known return type, typed call argument, `?:` branch typed by sibling). Diagnostic `GS0362` when no target type is available. |
| Smart casts / flow narrowing | Supported | Supported | `is` / `!is` on a local, parameter, or read-only top-level `let` narrows the receiver to the tested type. Composes through `!`, `&&`, `||` (De Morgan dual), `if`/`else`, the early-exit lift, `switch` arms, and `if let` / `guard let` / `while let`. Mutable receivers, fields, properties, and indexed expressions are not narrowed. |
| Trailing `func` lambdas | Supported | Supported | `call(...) func(...) { ... }` form. |
| Arrow lambda expressions (`(x int32) -> body`) | Supported | Supported | Parameter list is always parenthesised; body is a single expression or a brace block whose trailing expression is the value. Captures outer locals. Lambda parameter type inference and `(T) -> R` function-type syntax are supported separately. |

## Concurrency, async, and iterators

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| `go` | Supported | Supported with scheduling limits | Operand must be a call expression. No import (ADR-0174). |
| `scope` structured concurrency | Supported | Supported | Child tasks are joined and failures propagate. Not gated. |
| Channels: `chan[T]`, `in` / `out` handles, send, receive, two-value receive, `for v in ch`, `while let v = <-ch`, `ch.Close()` | Supported | Supported | `chan[T]` **is** `System.Threading.Channels.Channel<T>`; `chan[T](…)` constructs the runtime's `Chan<T>` (rendezvous at capacity 0). No import (ADR-0174). |
| `select` | Supported | Supported | Receive, receive-bind, send, and default cases. No import (ADR-0174). |
| `async func` and `await` | Supported | Supported by blocking | Emit has state machines; the evaluator blocked on awaiters. Not gated. |
| `suspend func` and inferred suspension | Supported | N/A | ADR-0174 D4: a plain `func` that performs a channel operation, or calls a function that suspends, is compiled as a `ValueTask[R]` state machine labelled `[Suspending]` and awaited implicitly by G# callers; `suspend func` pins the same shape at boundaries (`open`/`override`, interface members, lambdas). A call from a non-suspending, non-`async` function blocks and warns (GS0558). |
| Async state-machine edge cases | Partial | N/A | Unsupported emit shapes report `GS0190`. |
| `sequence[T]` and `yield` | Supported | Supported | Sync iterator state machines in emit; the evaluator collected sequence values. |
| `async sequence[T]` and `await for` | Supported | Supported by blocking | Maps to `IAsyncEnumerable[T]`. |

## CLR interop

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| Imported constructors | Supported | Supported by reflection | Includes simple-name construction when imported. |
| Imported instance/static methods | Supported | Supported by reflection | Overload resolution and conversions apply. |
| Imported fields/properties/indexers | Supported | Supported by reflection | Reads and writes are represented separately. |
| Imported events | Supported | Supported | `+=` and `-=` bind to event add/remove. |
| Imported extension methods | Supported | Supported | Uses imported `[Extension]` classes. |
| Imported optional/default arguments | Supported | Supported | Verified by sample coverage. |
| Function literal to delegate | Supported | Partial | Some marshalling scenarios are emit-path only. |
| Method group to delegate | Supported | Supported in covered scenarios | Includes imported CLR method groups. |
| Imported operator overloads and conversions | Supported | Supported where the evaluator invoked paths | Bound as CLR operator/conversion calls. |
| Attributes | Supported | Semantically recognized | Includes `@Attribute` sugar and `@Obsolete`; `@DllImport` opts into P/Invoke; `@LibraryImport` opts into the source-generator-shaped P/Invoke. |
| P/Invoke/`extern` | Supported | Supported (emit-only) | Attribute-driven via `@DllImport("lib")` on a `;`-body `func`, or via the source-generator-shaped `@LibraryImport("lib", StringMarshalling: …)`, which is AOT-friendly with an explicit IL stub. v1 marshals primitives, `string`, `*T` (byref), slices of primitives, and blittable / explicit-layout structs via `@StructLayout(LayoutKind.…)` + `@FieldOffset(N)`. `ref` / `out` / `in` parameters are supported for blittable pointees (primitives and `@StructLayout` structs); the runtime marshals the byref slot as `T*` to the unmanaged callee. Function-pointer marshalling supports both managed delegate callbacks (`@UnmanagedFunctionPointer(CallingConvention.Cdecl)` on the delegate type) and raw `unmanaged[Cdecl] (T) -> R` function pointers (encoded as `ELEMENT_TYPE_FNPTR` in metadata). Per-parameter `@MarshalAs(UnmanagedType.…)` overrides opt a parameter into a different unmanaged form (`LPWStr` for Windows `…W` entry-points, `LPUTF8Str` for modern C APIs, `I4` to widen a `bool` to a C `int` flag, `LPArray` with `SizeParamIndex:` for sibling-sized buffers, etc.). |

## Gsharp.Extensions helper namespaces

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| `Gsharp.Extensions.Optional` | Supported | Supported | Extension helpers on `T?` (`Map`, `FlatMap`, `OrElse`, `OrCompute`, `OrThrow`, `IfPresent`, `Filter`). Value-typed (`T : struct`) helpers carry a `*Value` suffix and require `import Gsharp.Extensions.Optional`. |
| `Gsharp.Extensions.Sequences` | Supported | Supported | Static builders (`Range`, `RangeStep`, `Iterate`, `Repeat`, `Of`, `Empty`), transformers (`Windowed`, `Chunked`, `Indexed`, `Pairwise`, `Interleave`), safe terminals (`FirstOrNil`, `LastOrNil`, `SingleOrNil` plus `*ValueOrNil` companions), and G#-shaped collectors (`ToSlice`, `ToMap`). Requires `import Gsharp.Extensions.Sequences`. |
| `Gsharp.Extensions.Go` (gate) | Removed | Removed | ADR-0174: the concurrency surface is the language, the Go-style built-ins are retired (GS0566), and the namespace is deleted. |
| No auto-import policy | N/A | N/A | Nothing under `Gsharp.Extensions.*` is auto-imported — even when implicit imports are enabled. Each namespace is opt-in per file. |

## Tooling and build

| Feature | Emit (current) | Evaluator (removed Phase 3c) | Notes |
| --- | --- | --- | --- |
| PE assembly emit | Supported | N/A | Direct `System.Reflection.Metadata` emitter. |
| Portable PDB, Source Link, embedded sources, deterministic IDs | Supported | N/A | Emit-only debug information. |
| Reference assemblies | Supported | N/A | SDK can produce reference assemblies. |
| SDK `.gsproj` build/run/pack | Supported | N/A | `Gsharp.NET.Sdk` integrates with MSBuild and `dotnet`. |
| REPL | Supported | Removed | `gsi` starts the emitted interactive REPL when no file is supplied. |
| Language server and VS Code extension | N/A | N/A | Pull-based diagnostics, semantic tokens, hover for CLR XML docs, CodeLens reference counts on members of types/structs/interfaces/enums, signature help, inlay hints, completion, go-to-definition, references, rename, formatting, debug + test integration. |
| VS Code color themes | N/A | N/A | Six bundled themes (Ember, Magma, Synthwave — Dark + Light each). |
