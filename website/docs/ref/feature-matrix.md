---
title: "Feature matrix"
sidebar_position: 4
draft: false
---

# Feature matrix

This matrix summarizes feature support in the compiler emit path (`gsc`) and the interpreter/REPL path. Legend: **Supported** means implemented on that path; **Mostly supported** means ordinary cases work with known edge limitations; **Partial** means syntax or binding exists but execution or emit is incomplete; **Not supported** means rejected or intentionally absent; **N/A** means the feature belongs to tooling rather than one execution path.

## Lexical and source structure

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Lexing, parsing, keywords, tokens, literals | Supported | Supported | Shared lexer and parser. |
| Packages, imports, import aliases | Supported | Supported | Emit supports multi-package assemblies; interpreter binds the same model. |
| Implicit `System` import | Supported | Supported | Enabled by default; disabled with `/noimplicitimports` or `/no-implicit-imports`. |
| Top-level statements and `func Main` | Supported | Supported | Mixing top-level statements and explicit `Main` is diagnosed by `GS0165`/`GS0166`. |
| Comments | Supported | Supported | Line (`//`), block (`/* … */`), and Markdown documentation (`///`, ADR-0057) comments. |
| String, raw string, and interpolated string literals | Supported | Supported | Sigil-free interpolation with `$name`/`${expr,alignment:format}`, delimiter-aware multiline holes, and `DefaultInterpolatedStringHandler`/`FormattableString` lowering (ADR-0055). |
| Character literals | Supported | Supported | Character diagnostics are `GS0191` through `GS0195`. |
| Documentation comments | Supported | Supported | `///` Markdown comments round-trip to CLR XML doc; hover renders CLR XML docs for imported APIs. Diagnostics `GS0227`–`GS0231`. |

## Types and values

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Primitive types and numeric operators | Supported | Mostly supported | Evaluator implements primitive arithmetic; address/deref unary operators are limited. |
| Width-bearing integer names | Supported | Supported | Canonical names are `int32`, `uint64`, and related widths; no built-in `int` alias. |
| Numeric conversions | Supported | Supported | ADR-0044 widening lattice plus explicit conversions. |
| `object` universal upper bound | Supported | Supported | Boxing and object equality are implemented. |
| Nullable `T?`, `nil`, `!!`, `?:`, `?.`, `?[i]` | Supported | Supported | `!!` throws in the evaluator when the value is nil. `?[i]` (ADR-0073) short-circuits indexing to `nil` when the receiver is nil. |
| Arrays and slices | Supported | Supported | Slices are backed by arrays; `append` copies. `len` / `cap` / `append` require `import Gsharp.Extensions.Go` (ADR-0083, GS0317); the .NET-idiomatic alternative is `.Length` and (for mutable lists) `List[T].Add`. |
| Maps | Supported | Supported | Backed by `Dictionary[K,V]`; `delete` and `len` are implemented. Both require `import Gsharp.Extensions.Go` (ADR-0083, GS0317); .NET-idiomatic alternatives are `.Remove(k)` and `.Count`. |
| Tuples and multi-return | Supported | Supported | Multi-value return syntax is represented as tuple literals. |
| Struct literals | Supported | Supported | Field initialization and field access are implemented. |
| Data classes, data structs, `with`/copy | Supported | Supported | `data class` (reference) and `data struct` (value) synthesise equality, `with`-copy, and deconstruction. The `record` keyword was removed by ADR-0078 (issue #718); migrate to `data struct` (preserves value semantics) or `data class` (reference semantics). |
| Inline structs | Supported | Supported | Exactly one field; participates in structural equality. |
| Classes and primary constructors | Supported | Partially supported | Evaluator supports G# classes; CLR base initializer modeling is limited. |
| Explicit class `init` constructors | Supported | Supported | G# class constructors are parsed, bound, and evaluated. |
| Interfaces | Supported | Supported for checking/upcasts | Default-interface methods (ADR-0085), static-virtual interface members (ADR-0089), `private` interface helper methods (ADR-0090 / issue #756), and the explicit-base interface call syntax `base[IFoo].M(...)` for DIM diamond disambiguation (ADR-0091 / issue #757) are supported. |
| Properties | Supported | Supported | Auto/computed and static/shared forms are represented. |
| Events | Supported | Supported | G# and CLR event subscription paths exist. |
| Static/shared members | Supported | Supported | Declared in a `shared { ... }` block. |
| Function types, literals, closures | Supported | Supported | Delegate conversions are strongest on the emit path. |
| Generics and method inference | Supported | Supported for binding/evaluation | Metadata specs plus type-erased handling for open type-parameter-containing shapes (audited and staged for elimination in [ADR-0087](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0087-reified-generics-emit-audit.md); supersedes #484). |
| Variance and constraints | Supported semantically | Supported semantically | Diagnostics include `GS0150` through `GS0153`. |
| By-ref and pointers | Partial | Limited/not supported | `&` / `*` / `*T` for CLR `ref`/`out`/`in` interop (ADR-0039); ref returns auto-dereference in rvalue position (ADR-0056 §1). Evaluator rejects generic address/deref execution. |
| `ref`/`out`/`in` parameters | Supported | Supported | Declaration-site and call-site modifiers per ADR-0060; diagnostics `GS0235`–`GS0243`. Includes `out var/let/_` inline declarations. |
| Ref-aliasing locals (`let ref` / `var ref`) | Supported | Supported | Local whose IL slot is `T&` and aliases another lvalue. Diagnostics `GS0256`–`GS0258`. |
| `ref`-returning functions | Supported | Supported | `func f(...) ref T { ... }` paired with `return ref <lvalue>`. Diagnostics `GS0248`–`GS0255`. |
| `scoped` parameter modifier | Supported | Supported | Constrains a `ref struct` / managed-pointer parameter from escaping; enforced by `GS9004` / `GS9006`. |
| Spans and `ref struct` types | Mostly supported | Limited | Stack-only consumption of `Span[T]` / `ReadOnlySpan[T]` and user `ref struct X`: element read/write, `[]T`→span conversion, closed generic value-type fields (ADR-0056). Escape rules are `GS0219`; `ReadOnlySpan[T]` writes are `GS0226`. Full ref-safe-to-escape analysis is deferred (#376). |

## Declarations and members

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Top-level functions and variables | Supported | Supported | `var`, `let`, and `const` are implemented. The legacy `:=` short variable declaration was removed by ADR-0077 (issue #717); the parser hard-rejects it with `GS0305`. |
| Visibility modifiers | Supported | Supported | `public`, `internal`, and `private`; invalid locations report `GS0180`. |
| Receiver methods and extension functions | Supported | Supported | G# receiver style and imported CLR extension dispatch. ADR-0079 reserves the receiver-clause form for non-owned receiver types and warns (`GS0314`) when it targets an owned class or struct; in-body declarations are the canonical form for owned-type methods. |
| Operator declarations | Supported | Supported where evaluator invokes user/CLR op paths | Receiver `operator` declarations map to CLR `op_*` names. |
| Interface implementation | Supported | Supported for checks/upcasts | Missing members and sealed-interface violations are diagnosed. |
| Inheritance and overrides | Supported | Partially supported | Base classes must be `open`; override diagnostics are implemented. |
| Default parameter values in G# declarations | Supported | Supported | ADR-0063. Optional parameters carry compile-time-constant defaults; rule violations report `GS0265`. |
| Method overloading (user functions) | Supported | Supported | ADR-0063 / ADR-0088. Functions can carry overload sets differing by parameter types, ref-kinds, or generic-parameter constraints (`where T : class` / `where T : struct`); duplicates report `GS0264`, ambiguous calls report `GS0266` or `GS0160`, no-applicable reports `GS0267`. |
| Named delegate types | Supported | Supported | ADR-0059. `type X = delegate func(...)` declares a real CLR `MulticastDelegate`-derived type; diagnostics `GS0233`–`GS0234`. |

## Statements and control flow

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| `if` | Supported | Supported | Includes simple-statement form. The `if let name = expr { ... } [else { ... }]` binding form (ADR-0071) strips a nullable layer and narrows `name` to the underlying type inside the then-branch. ADR-0064 also exposes `if` as a value-producing expression — see the *If expression* row below. |
| `if` expression (ADR-0064) | Supported | Supported | `let x = if cond { a } else { b }` and `else if` chains in value position. Requires a terminal `else` (`GS0276`); blocks must end in a value-producing expression (`GS0277`); branches with no common type report `GS0263` (shared with the ternary). Lowers through the same `BoundConditionalExpression` / `BoundBlockExpression` nodes the ternary and switch expression use. |
| `guard let` | Supported | Supported | ADR-0071. `guard let name = expr else { ... }` binds `name` for the remainder of the enclosing block and requires the else clause to unconditionally exit (`GS0297`). |
| `for` condition, clause, infinite loops | Supported | Supported | Companion `while` and `do`-`while` forms shipped in ADR-0070. |
| `for x in collection` | Supported | Supported | Canonical `in` form. The legacy `for x := range collection` Go-style spelling was removed by ADR-0077 (issue #717). |
| Ellipsis loops | Supported | Supported | `for i in start ... end`. The legacy `for i := start ... end` spelling was removed by ADR-0077 (issue #717). |
| `while` and `do`-`while` | Supported | Supported | ADR-0070. `while cond { ... }` (pre-test) and `do { ... } while cond` (post-test). |
| `break` and `continue` (with optional loop labels) | Supported | Supported | Invalid locations are diagnosed. Loop labels (`label: for ...`, `break label`, `continue label`) added in ADR-0070; diagnostics `GS0293`–`GS0295`. |
| Multi-assignment and deconstruction | Supported | Supported | Target/value mismatches are diagnosed. |
| Null-coalescing compound assignment (`??=`) | Supported | Supported | ADR-0072. `a ??= b` writes `b` only when `a` reads as `nil`; RHS short-circuits otherwise. Receiver and index expressions evaluated exactly once. Works on locals, fields, properties, and indexers. Non-nullable LHS reports `GS0298`; non-assignable LHS reports `GS0299`. |
| `switch` statements | Supported | Supported | Cases do not fall through. ADR-0069 (+ #712 addendum) flow-narrows the discriminator inside type-pattern arms (`case d is T`) and lifts a common narrowing into the rest of the enclosing block when the switch is exhaustive and every non-exiting arm contributes the same narrowing. |
| Switch expressions | Supported | Supported | Exhaustiveness and arm type diagnostics implemented. |
| Patterns | Supported | Supported | Constant, relational, type, property, list, and discard patterns are represented. |
| `fallthrough` | Not supported | Not supported | Reserved and diagnosed as `GS0168`. |
| `try`, `catch`, `finally`, `throw` | Supported | Supported | CLR exception model. |
| `using` | Supported | Supported if lowered/bound disposable | Resource-scope variable declaration. |
| `defer` | Supported by binding/lowering intent | Supported when lowered before evaluation | Binder requires a call expression. |
| `goto` | Partial | Partial | Token and bound label/goto nodes exist; use with caution pending fuller docs. |

## Expressions

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Calls and generic calls | Supported | Supported | Bracketed type arguments. |
| Named arguments | Supported | Supported | `Foo(timeout: 30, retries: 3)` for free functions, user methods/constructors, extension functions, and inherited CLR methods (including delegate `Invoke`). The legacy `Foo(timeout = 30)` shape is deprecated and emits `GS0315` ([ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md), issue #720); both spellings still parse for one release. Indirect calls through a function-typed variable and variadic targets are excluded. Diagnostics `GS0244`–`GS0247`, `GS0315`. |
| Conditional (`?:`) ternary expression | Supported | Supported | Generalized in ADR-0062; `cond ? a : b` is a normal expression. `GS0263` covers the "no common type" failure. |
| Conditional ref-arguments (`ref cond ? a : b`) | Supported | Supported | ADR-0061. Branches must produce same-typed lvalues. Diagnostics `GS0260`–`GS0262`. |
| Struct, array, and map literals | Supported | Supported | Map literals bind to `Dictionary[K,V]` backing. |
| Indexing and index assignment | Supported | Supported | Arrays, slices, maps, and imported CLR indexers. |
| Null-conditional access | Supported | Supported | `?.` and `?[i]` (ADR-0073) represented in the bound tree. `?[i]` covers arrays, slices, maps, and CLR indexers; non-nullable receiver warns `GS0300`; `?[i]` rejected as assignment LHS (`GS0301`). |
| Type operators | Supported | Supported | `typeof(...)` and `nameof(...)`. |
| Smart casts / flow narrowing | Supported | Supported | ADR-0069 (+ #712 addendum). `is` / `!is` on a local, parameter, or read-only top-level `let` narrows the receiver to the tested type. Composes through `!`, `&&`, `||` (De Morgan dual), `if`/`else`, the early-exit lift, `switch` arms, and `if let` / `guard let`. Mutable receivers, fields, properties, and indexed expressions are not narrowed. |
| Trailing `func` lambdas | Supported | Supported | `call(...) func(...) { ... }` form. |
| Arrow lambda expressions (`(x int32) -> body`) | Supported | Supported | ADR-0074 / issue #714. Parameter list is always parenthesised; body is a single expression or a brace block whose trailing expression is the value. Captures outer locals. Lambda parameter type inference and `(T) -> R` function-type syntax are tracked separately (issues #715, #716). |

## Concurrency, async, and iterators

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| `go` | Supported | Supported with evaluator scheduling limits | Operand must be a call expression. Per-file `import Gsharp.Extensions.Go` is required (ADR-0082, GS0316). |
| `scope` structured concurrency | Supported | Supported | Child tasks are joined and failures propagate. Not gated. |
| Channels, send, receive, `close` | Supported | Supported | Backed by `System.Threading.Channels`. Per-file `import Gsharp.Extensions.Go` is required (ADR-0082, GS0316). |
| `select` | Supported | Supported | Receive, receive-bind, send, and default cases. Per-file `import Gsharp.Extensions.Go` is required (ADR-0082, GS0316). |
| `async func` and `await` | Supported | Supported by blocking | Emit has state machines; evaluator blocks on awaiters. Not gated. |
| Async state-machine edge cases | Partial | N/A | Unsupported emit shapes report `GS0190`. |
| `sequence[T]` and `yield` | Supported | Supported | Sync iterator state machines in emit; evaluator collects sequence values. |
| `async sequence[T]` and `await for` | Supported | Supported by blocking | Maps to `IAsyncEnumerable[T]`. |

## CLR interop

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Imported constructors | Supported | Supported by reflection | Includes simple-name construction when imported. |
| Imported instance/static methods | Supported | Supported by reflection | Overload resolution and conversions apply. |
| Imported fields/properties/indexers | Supported | Supported by reflection | Reads and writes are represented separately. |
| Imported events | Supported | Supported | `+=` and `-=` bind to event add/remove. |
| Imported extension methods | Supported | Supported | Uses imported `[Extension]` classes. |
| Imported optional/default arguments | Supported | Supported | Verified by sample coverage. |
| Function literal to delegate | Supported | Partial | Some marshalling scenarios are emit-path only. |
| Method group to delegate | Supported | Supported in covered scenarios | Includes imported CLR method groups. |
| Imported operator overloads and conversions | Supported | Supported where evaluator invokes paths | Bound as CLR operator/conversion calls. |
| Attributes | Supported | Semantically recognized | Includes `@Attribute` sugar and `@Obsolete`; `@DllImport` opts into P/Invoke (ADR-0086). |
| P/Invoke/`extern` | Supported | Supported (emit-only) | Attribute-driven via `@DllImport("lib")` on a `;`-body `func` (ADR-0086 / issue #727). v1 marshals primitives, `string`, `*T` (byref), and slices of primitives. |

## Gsharp.Extensions helper namespaces

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| `Gsharp.Extensions.Optional` | Supported | Supported | Extension helpers on `T?` (`Map`, `FlatMap`, `OrElse`, `OrCompute`, `OrThrow`, `IfPresent`, `Filter`). Value-typed (`T : struct`) helpers carry a `*Value` suffix per ADR-0084 (L1). Requires `import Gsharp.Extensions.Optional`. |
| `Gsharp.Extensions.Sequences` | Supported | Supported | Static builders (`Range`, `RangeStep`, `Iterate`, `Repeat`, `Of`, `Empty`), transformers (`Windowed`, `Chunked`, `Indexed`, `Pairwise`, `Interleave`), safe terminals (`FirstOrNil`, `LastOrNil`, `SingleOrNil` plus `*ValueOrNil` companions), and G#-shaped collectors (`ToSlice`, `ToMap`). Requires `import Gsharp.Extensions.Sequences`. |
| `Gsharp.Extensions.Go` (gate) | Supported | Supported | Per-file `import Gsharp.Extensions.Go` unlocks the Go-flavored concurrency surface (ADR-0082) and the Go-style built-ins `len`, `cap`, `append`, `delete`, `make` (ADR-0083). |
| No auto-import policy | N/A | N/A | Nothing under `Gsharp.Extensions.*` is auto-imported — even when implicit imports are enabled. Each namespace is opt-in per file. |

## Tooling and build

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| PE assembly emit | Supported | N/A | Direct `System.Reflection.Metadata` emitter. |
| Portable PDB, Source Link, embedded sources, deterministic IDs | Supported | N/A | Emit-only debug information. |
| Reference assemblies | Supported | N/A | SDK can produce reference assemblies. |
| SDK `.gsproj` build/run/pack | Supported | N/A | `Gsharp.NET.Sdk` integrates with MSBuild and `dotnet`. |
| REPL | N/A | Supported | Interpreter executable starts a REPL with no file argument. |
| Language server and VS Code extension | N/A | N/A | Pull-based diagnostics, semantic tokens, hover for CLR XML docs, CodeLens reference counts on members of types/structs/interfaces/enums, signature help, inlay hints, completion, go-to-definition, references, rename, formatting, debug + test integration. |
| VS Code color themes | N/A | N/A | Six bundled themes (Ember, Magma, Synthwave — Dark + Light each). |
