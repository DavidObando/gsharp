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
| Comments | Supported | Supported | Line and block comments are accepted by the compiler lexer; editor grammar may lag. |
| String, raw string, and interpolated string literals | Supported | Supported | Interpolation is parsed into expression segments. |
| Character literals | Supported | Supported | Character diagnostics are `GS0191` through `GS0195`. |

## Types and values

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Primitive types and numeric operators | Supported | Mostly supported | Evaluator implements primitive arithmetic; address/deref unary operators are limited. |
| Width-bearing integer names | Supported | Supported | Canonical names are `int32`, `uint64`, and related widths; no built-in `int` alias. |
| Numeric conversions | Supported | Supported | ADR-0044 widening lattice plus explicit conversions. |
| `object` universal upper bound | Supported | Supported | Boxing and object equality are implemented. |
| Nullable `T?`, `nil`, `!!`, `?:`, `?.` | Supported | Supported | `!!` throws in the evaluator when the value is nil. |
| Arrays and slices | Supported | Supported | Slices are backed by arrays; `append` copies. |
| Maps | Supported | Supported | Backed by `Dictionary[K,V]`; `delete` and `len` are implemented. |
| Tuples and multi-return | Supported | Supported | Multi-value return syntax is represented as tuple literals. |
| Struct literals | Supported | Supported | Field initialization and field access are implemented. |
| Data structs, records, `with`/copy | Supported | Supported | `record` is an alias for `data struct`; data equality and ergonomics are implemented. |
| Inline structs | Supported | Supported | Exactly one field; participates in structural equality. |
| Classes and primary constructors | Supported | Partially supported | Evaluator supports G# classes; CLR base initializer modeling is limited. |
| Explicit class `init` constructors | Supported | Supported | G# class constructors are parsed, bound, and evaluated. |
| Interfaces | Supported | Supported for checking/upcasts | Interface method bodies are rejected; default interface methods are not implemented. |
| Properties | Supported | Supported | Auto/computed and static/shared forms are represented. |
| Events | Supported | Supported | G# and CLR event subscription paths exist. |
| Static/shared members | Supported | Supported | Declared in a `shared { ... }` block. |
| Function types, literals, closures | Supported | Supported | Delegate conversions are strongest on the emit path. |
| Generics and method inference | Supported | Supported for binding/evaluation | Metadata specs plus type-erased handling for open type-parameter-containing shapes. |
| Variance and constraints | Supported semantically | Supported semantically | Diagnostics include `GS0150` through `GS0153`. |
| By-ref and pointers | Partial | Limited/not supported | Syntax and diagnostics exist; evaluator rejects generic address/deref execution. |

## Declarations and members

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| Top-level functions and variables | Supported | Supported | `var`, `let`, `const`, and `:=` are implemented. |
| Visibility modifiers | Supported | Supported | `public`, `internal`, and `private`; invalid locations report `GS0180`. |
| Receiver methods and extension functions | Supported | Supported | G# receiver style and imported CLR extension dispatch. |
| Operator declarations | Supported | Supported where evaluator invokes user/CLR op paths | Receiver `operator` declarations map to CLR `op_*` names. |
| Interface implementation | Supported | Supported for checks/upcasts | Missing members and sealed-interface violations are diagnosed. |
| Inheritance and overrides | Supported | Partially supported | Base classes must be `open`; override diagnostics are implemented. |
| Default parameter values in G# declarations | Not supported | Not supported | Parser parameter grammar has no initializer. |

## Statements and control flow

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| `if` | Supported | Supported | Includes simple-statement form. |
| `for` condition, clause, infinite loops | Supported | Supported | There is no `while` keyword. |
| `for x in collection` and `for x := range collection` | Supported | Supported | Canonical `in` form plus Go-style range form. |
| Ellipsis loops | Supported | Supported | `for i := start ... end`. |
| `break` and `continue` | Supported | Supported | Invalid locations are diagnosed. |
| Multi-assignment and deconstruction | Supported | Supported | Target/value mismatches are diagnosed. |
| `switch` statements | Supported | Supported | Cases do not fall through. |
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
| Named arguments | Partial | Partial | Accepted for data-struct copy and imported optional/default argument scenarios. |
| Struct, array, and map literals | Supported | Supported | Map literals bind to `Dictionary[K,V]` backing. |
| Indexing and index assignment | Supported | Supported | Arrays, slices, maps, and imported CLR indexers. |
| Null-conditional access | Supported | Supported | `?.` represented in the bound tree. |
| Type operators | Supported | Supported | `typeof(...)` and `nameof(...)`. |
| Trailing `func` lambdas | Supported | Supported | `call(...) func(...) { ... }` form. |
| Arrow trailing lambdas | Not supported | Not supported | ADR-0050 is proposed; current parser uses `->` for switch-expression arms. |

## Concurrency, async, and iterators

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| `go` | Supported | Supported with evaluator scheduling limits | Operand must be a call expression. |
| `scope` structured concurrency | Supported | Supported | Child tasks are joined and failures propagate. |
| Channels, send, receive, `close` | Supported | Supported | Backed by `System.Threading.Channels`. |
| `select` | Supported | Supported | Receive, receive-bind, send, and default cases. |
| `async func` and `await` | Supported | Supported by blocking | Emit has state machines; evaluator blocks on awaiters. |
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
| Attributes | Supported | Semantically recognized | Includes `@Attribute` sugar and `@Obsolete`; `[DllImport]` reports `GS0211`. |
| P/Invoke/`extern` | Not supported | Not supported | Recognized unsupported surface only. |

## Tooling and build

| Feature | Emit (`gsc`) | Interpreter | Notes |
| --- | --- | --- | --- |
| PE assembly emit | Supported | N/A | Direct `System.Reflection.Metadata` emitter. |
| Portable PDB, Source Link, embedded sources, deterministic IDs | Supported | N/A | Emit-only debug information. |
| Reference assemblies | Supported | N/A | SDK can produce reference assemblies. |
| SDK `.gsproj` build/run/pack | Supported | N/A | `Gsharp.NET.Sdk` integrates with MSBuild and `dotnet`. |
| REPL | N/A | Supported | Interpreter executable starts a REPL with no file argument. |
| Language server and VS Code extension | N/A | N/A | Tooling uses parser/binder services and provides rich editor capabilities. |
