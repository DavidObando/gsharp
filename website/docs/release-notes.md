---
title: "Release notes"
draft: false
---

# Release notes

G# is pre-1.0. The repository's version base is currently `0.2`, and product versions are derived by Nerdbank.GitVersioning from that base and the Git commit. Until the project reaches a stable compatibility promise, release notes should be read as implementation status notes rather than a long-term compatibility contract.

## 0.2

The second pre-1.0 line ("Oats" sweep, parent epic #706). v0.2 is a
syntax-and-ergonomics release: the parser, binder, and emitter all
absorbed substantial additions, several legacy Go-flavored spellings
were retired in favour of canonical G# forms, and the native-interop
and default-interface-method surfaces shipped end-to-end. This release
also formally introduces docs versioning — the `0.1` snapshot is
removed and a fresh `0.2` snapshot is cut from the live docs.

### Highlights

- **New language surface.** `while` / `do…while` + labeled
  `break`/`continue` ([ADR-0070](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0070-while-do-loops-and-labeled-break-continue.md)),
  `if let` / `guard let` smart-cast bindings ([ADR-0071](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0071-if-let-guard-let-bindings.md)),
  null-coalescing compound assignment `??=` ([ADR-0072](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0072-null-coalescing-compound-assignment.md)),
  null-conditional indexing `a?[i]` ([ADR-0073](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0073-null-conditional-indexing.md)),
  arrow lambdas `x => body` ([ADR-0074](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0074-arrow-lambda-expressions.md)),
  the canonical `(T1, T2) -> R` function-type clause ([ADR-0075](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0075-function-type-clause-arrow-syntax.md)),
  lambda binding-type inference ([ADR-0076](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0076-lambda-binding-type-inference.md)),
  Kotlin/Swift-style type-declaration grammar ([ADR-0078](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0078-kotlin-swift-style-type-declarations.md)),
  if-as-expression finished ([ADR-0064](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0064-if-expression.md), issue #711),
  smart-cast extensions (ADR-0069 addendum), discriminated-union
  enum payloads (issue #725), `default(T)` and target-typed bare
  `default` ([ADR-0100](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0100-default-expression.md)),
  variadic `...T` parameters ([ADR-0101](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0101-variadic-parameters.md)) including
  the variadic slot inside anonymous function-type clauses
  ([ADR-0102](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0102-variadic-anonymous-function-type-clause.md))
  and at every declaration site ([ADR-0103](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0103-variadic-all-declaration-sites.md)),
  `class` / `struct` / `new()` constraint flag spellings
  ([ADR-0097](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0097-class-struct-new-constraints.md)),
  default-interface methods ([ADR-0085](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0085-default-interface-methods.md),
  [ADR-0089](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0089-default-interface-methods-static-virtual.md),
  [ADR-0090](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0090-default-interface-methods-private-helpers.md),
  [ADR-0091](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0091-default-interface-methods-explicit-base.md)),
  reified generics ([ADR-0087](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0087-reified-generics.md) R1–R7),
  `Gsharp.Extensions.Optional` and `Gsharp.Extensions.Sequences`
  ([ADR-0084](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0084-extensions-optional-sequences.md)),
  friendly numeric type aliases ([ADR-0098](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0098-friendly-numeric-type-aliases.md)),
  and the canonical map type clause `map[K,V]`
  ([ADR-0104](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0104-map-type-clause-canonical-spelling.md)).
- **Removals (breaking).** Five legacy spellings were retired this
  cycle. The lexer / parser still recognise each shape long enough to
  emit a focused span-accurate diagnostic with the canonical
  replacement, so IDE quick-fixes can patch in one edit:
  - `type` keyword for type declarations (`type Foo struct { … }` →
    `struct Foo { … }`) — [ADR-0078](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0078-kotlin-swift-style-type-declarations.md).
  - `record` keyword (use `data class` or `data struct`) — ADR-0078.
  - `:=` short variable declaration (use `let` / `var`) —
    [ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md), `GS0305`.
  - `name = value` named-argument separator (use `name: value`)
    deprecated this release —
    [ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md), `GS0315`.
  - `func(T) R` legacy function-type clause (use `(T) -> R`)
    deprecated this release —
    [ADR-0075](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0075-function-type-clause-arrow-syntax.md), `GS0303`.
  - Go-flavored `map[K]V` type clause (use `map[K,V]`) — ADR-0104, `GS0366`.
  - `static func` modifier on interface methods removed (issue #865 revision of
    [ADR-0089](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0089-static-virtual-interface-members.md)).
    Static-virtual interface members are now declared inside a `shared { … }`
    block on the interface — the same `shared { … }` block that hosts static
    members on classes and structs (ADR-0053). A body-less `func` inside that
    block is an abstract static-virtual slot; a `func` with a body is the
    default. Static private helpers (ADR-0090) move alongside, written as
    `private func` inside the interface's `shared { … }` block. Instance
    `private func` helpers stay directly in the interface body, unchanged.
    The `static` keyword is no longer recognised on the interface surface;
    the old `static func …` shape now produces a generic parser error
    (GS0005) and there is no dedicated migration diagnostic. GS0330 is
    repurposed: it now fires when a non-`func` member appears inside an
    interface `shared { … }` block. The CLR emit shape, interpreter
    dispatch, and binder semantics are unchanged — this is a front-end
    surface change only.
- **Body-less `func` now requires `;` (breaking).** A `func` declaration without a `{ … }` block is terminated by a required `;` — the universal no-body marker (issue #881, revision of [ADR-0085](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0085-default-interface-methods-implementation.md)). This already held for P/Invoke (`func getpid() int32;`); it now also applies to abstract interface methods and abstract static-virtual slots inside an interface `shared { … }` block. The old terminator-less form (`func Area() float64`) is removed: a body-less interface `func` missing its `;` reports `GS0368`. A `func` carrying a body still takes no `;`. The binder, emitter, and interpreter are unchanged — this is a front-end surface change only.
- **Native interop end-to-end.** P/Invoke via `@DllImport`
  ([ADR-0086](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0086-pinvoke-dllimport.md)),
  source-generator-shaped `@LibraryImport`
  ([ADR-0092](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0092-pinvoke-libraryimport.md)),
  struct/class marshalling
  ([ADR-0093](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0093-pinvoke-struct-marshalling.md)),
  `ref` / `out` / `in` parameter marshalling
  ([ADR-0094](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0094-pinvoke-ref-out-in.md)),
  function-pointer marshalling
  ([ADR-0095](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0095-pinvoke-function-pointers.md)),
  and `@MarshalAs` parameter overrides
  ([ADR-0096](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0096-pinvoke-marshalas-parameter-overrides.md)).
- **Go-flavored concurrency moved behind an opt-in import.** `go`,
  `chan`, `select`, channel send/receive, `make(chan T)` and the
  built-ins `len`, `cap`, `append`, `make`, `delete` now require
  `import Gsharp.Extensions.Go` ([ADR-0082](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0082-go-concurrency-extensions.md),
  [ADR-0083](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0083-go-builtins-extensions.md)).
  Diagnostics `GS0316` / `GS0317` point at the missing import.
- **Tooling polish.** LSP completion polish for async-shaped types
  (`async (T) -> R`, `async sequence[T]`) (#713); nil-related quick
  fixes from `textDocument/codeAction` ([ADR-0099](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0099-lsp-nil-quick-fixes.md));
  `null` → `nil` "did you mean" diagnostic
  ([ADR-0081](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0081-null-to-nil-did-you-mean.md), `GS0273`).
- **Diagnostics catalogue extended.** v0.2 introduces GS0273,
  GS0288–GS0366. The [Diagnostics reference](./ref/diagnostics.md)
  has the per-ID cause/fix detail.

### Added

- **`default(T)` and target-typed bare `default` expression** ([ADR-0100](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0100-default-expression.md), issue #795) — generic G# functions can now spell the zero-initialised value of a type parameter via `default(T)`, with C#-compatible semantics: `0`/`false`/`0.0` for built-in value types, `nil` for reference types and `T?`, field-wise zero for user structs, and the runtime substitution of `T` for an unconstrained type parameter (emitted as `ldloca; initobj T; ldloc` per ADR-0087). The bare `default` literal is accepted in target-typed positions — `let x int32 = default`, `return default` when the return type is known, an argument to a typed parameter, and a `?:` branch typed by its sibling. Diagnostic `GS0362` fires when no target type is available. The arm-leader use of `default` inside `switch`/`select` is unchanged. Unblocks the dogfooded port of `Optional` / `Sequences` (#792).
- **Friendly numeric type aliases** ([ADR-0098](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0098-friendly-numeric-type-aliases.md), issue #729) — `int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, and `double` are accepted everywhere a type name is accepted, as a strict superset on top of the canonical width-bearing names (`int32`, `uint32`, …). The alias resolves to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, `nameof`, hover, and emitted IL always print the canonical width-bearing spelling. Canonical names remain preferred in documentation and public library APIs; the aliases are appropriate inside function bodies and local code. Aliases are reserved type names — `type int = string` (and equivalents) is rejected with `GS0102` the same way `type int32 = string` already is.
- **Null-conditional indexing `a?[i]`** ([ADR-0073](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0073-null-conditional-indexing.md), issue #710) — `a?[i]` evaluates the receiver `a` exactly once; if it is `nil` the whole expression yields `nil`, otherwise the result is the indexed value lifted to the nullable form of the indexer's return type. Works on arrays, slices, maps, and CLR indexers, on both emit and interpreter paths. Chained forms (`h?.Data?[i]?.c`) short-circuit on the first nil. The new token `?[` is recognized only when `[` immediately follows `?` (no whitespace), preserving `cond ? [arr] : [arr]` ternary parses. Diagnostics `GS0300` (warning: non-nullable receiver) and `GS0301` (error: not allowed on assignment LHS).
- **Documentation comments** ([ADR-0057](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0057-documentation-comments.md)) — Markdown-authored `///` documentation comments that round-trip losslessly to CLR XML doc. Hover renders the merged documentation for both G# declarations and imported CLR APIs. New warnings: `GS0227` (unattached), `GS0228` (missing on public, opt-in), `GS0229` (`@param` mismatch), `GS0230` (unsupported Markdown), `GS0231` (unknown tag).
- **Named delegate types** ([ADR-0059](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0059-named-delegate-types.md)) — `type Name = delegate func(...)` declares a real CLR `MulticastDelegate`-derived type so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types. Diagnostics `GS0233`–`GS0234`.
- **`ref`/`out`/`in` parameters** ([ADR-0060](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0060-ref-out-in-parameters.md)) — Declaration-site and call-site ref-kind modifiers, including inline `out var/let/_` declarations. Diagnostics `GS0235`–`GS0243`. Passing a value to an `in` parameter without writing `in` at the call site is the warning `GS0242` rather than a silent spill (a deliberate departure from C#).
- **Ref-aliasing locals** (ADR-0060 follow-up) — `let ref m = arr[i]` / `var ref v = c.Field` produces a local whose IL slot is `T&` and aliases another lvalue. Diagnostics `GS0256`–`GS0258`.
- **Ref returns** (ADR-0060 follow-up, issue #490) — `func f(...) ref T { return ref <expr> }`. Diagnostics `GS0248`–`GS0255` cover the surrounding rules (escape, async/iterator ban, override match).
- **Conditional ref-arguments** ([ADR-0061](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0061-conditional-ref-arguments.md)) — narrow `ref cond ? a : b` form inside ref-kind argument payloads; diagnostics `GS0260`–`GS0262`.
- **Generalized ternary expression** ([ADR-0062](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0062-generalized-ternary-expression.md)) — `cond ? a : b` is now a normal expression. `GS0259` is retired in value contexts; the new `GS0263` covers the "no common type" failure.
- **Method overloading and optional parameters** ([ADR-0063](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0063-method-overloading-and-optional-parameters.md)) — user G# functions can carry overload sets (differing by parameter types or ref-kinds) and optional parameters with compile-time-constant defaults. Diagnostics `GS0264`–`GS0267`.
- **Named arguments at call sites** (issue #343) — `Foo(timeout: 30, retries: 3)` for free functions, user methods, user constructors, extension functions, and inherited CLR methods (including delegate `Invoke`). Diagnostics `GS0244`–`GS0247`. The legacy `name = value` form is deprecated this release (`GS0315`, [ADR-0080](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0080-deprecate-equals-named-arguments.md), issue #720) — both spellings still parse, but `=` will be removed in a later release. Migrate `.copy(...)` and attribute argument lists alongside ordinary call sites.
- **`scoped` parameter modifier** ([ADR-0058](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0058-ref-safe-to-escape.md)) — constrains a `ref struct` / managed-pointer parameter from escaping; enforced by `GS9004` / `GS9006`.
- **`data struct` synthesis completed** ([ADR-0029](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0029-data-struct-synthesized-members.md), issue #410) — every `data struct` synthesizes `Equals(object)`, `Equals(T)`, `GetHashCode()`, `ToString()`, `op_Equality`, `op_Inequality`, and `Deconstruct(...)`. Hand-written versions are rejected (`GS0232`).
- **Editor features** — hover for CLR XML docs (#397), live pull-based diagnostics (#362), CodeLens reference counts on members of structs, interfaces, and enums (#403), implicit `this` for properties/methods/events (#412), hover for `this` (#413), bare static-member access from instance methods (#485), chained-member hover (#402), and six VS Code color themes inspired by the G# logo (Ember, Magma, Synthwave — Dark + Light each, #357).
- **`:=` short variable declaration removed** ([ADR-0077](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0077-drop-colon-equals-short-variable-declaration.md), issue #717) — every binding site now requires `let` (immutable) or `var` (mutable). The lexer keeps recognising `:=` so the parser can emit `GS0305` with a context-sensitive migration suggestion (`x := 1` → `let x = 1`; `for i := 0 ... 10` → `for i in 0 ... 10`; `case v := <-ch` → `case let v = <-ch`; etc.) instead of cascading parse errors. Supersedes ADR-0008 on this point.

### Changed

- The website spec, feature matrix, FAQ, bridges page, guide pages, and design-decisions index were refreshed to match the compiler ground truth — most visibly, "Parameters do not have default-value syntax" and "Named arguments — Partial" are no longer correct and were rewritten.
- The repo `docs/lexical.md` block-comment paragraph (which incorrectly claimed block comments were not implemented) is corrected, and a documentation-comments subsection was added.
- The VS Code TextMate grammar adds the missing contextual keywords (`data`, `inline`, `record`, `delegate`, `event`, `prop`, `init`, `shared`, `scoped`, accessor names `get`/`set`/`add`/`remove`/`raise`, ref-kinds `ref`/`out`), operators (`:=`, `?.`, `??`, `?`/`:`, `!!`, `...`, `=>`), an `@Annotation` scope, and a `///` documentation-comment scope with `@tag` highlighting. The VS Code snippet set was rewritten to match current grammar.
- The Docusaurus site cuts a new `0.2` snapshot from the live docs and retires the `0.1` snapshot. The version dropdown lists `0.2` and `Next`; the `0.1` URL space is no longer served.

### Fixed

- Numerous IL-emit hardening rounds (issues #418, #419, #420, #421) and a new `ilverify` gate (#478) ensure emitted assemblies pass CLR verification.
- Determinism golden test (#475) freezes emitted bytes for byte-for-byte reproducibility.
- `FieldAccessException` on class auto-properties (#399).
- CodeLens 0-refs and stale-tree fixes (#414).

### Known issues

- The full ref-safe-to-escape escape analysis is partial; `GS0257` is reserved for a future pass.
- Async state-machine emit shapes that are not yet supported continue to report `GS0190`.

## 0.1

The `0.1` version base identifies the current pre-1.0 line. This is not a dated stable release announcement; it summarizes the major capabilities implemented in the repository today.

### Language and libraries

- Packages, imports, import aliases, top-level declarations, and multi-file or multi-package compilation.
- Width-bearing primitive names such as `int32`, `uint64`, `float32`, and `float64`, plus `bool`, `char`, `string`, `object`, `decimal`, `nint`, `nuint`, and `void`.
- Nullable `T?` types with `nil`, `?.`, `??`, and `!!`.
- Structs, classes, interfaces, enums, `data struct`, `record` as a `data struct` alias, and `inline struct` value wrappers.
- Generic functions and types with square-bracket type parameters and arguments, constraints, method inference, and CLR variance support where applicable.
- Fixed arrays, slices, maps, tuples, function values, delegates, `sequence[T]`, `async sequence[T]`, and iterator `yield` support.
- Control flow including `if`, `for`, `for in` or `range` forms, switches, switch expressions, `try`, `catch`, `finally`, `throw`, `using`, and `defer`.
- Go-shaped concurrency with `go`, `scope`, channels, channel send and receive, `make(chan T)`, `close`, and `select`.
- `async func`, `await`, async lambdas, awaitable-shape support, and `await for` over async sequences.
- CLR interop for imported constructors, methods, overload resolution, fields, properties, indexers, events, delegates, extension methods, optional CLR arguments, operators, conversions, attributes, and generic types.

### Tooling

- `gsc` compiler driver with an interpreter path when no `/out:` is supplied and an emit path for managed executables or libraries.
- Managed PE and metadata emission without Roslyn, optional reference assemblies, target-framework-aware reference resolution, runtime configuration output, and Portable PDB support.
- MSBuild SDK support through `Gsharp.NET.Sdk`, `.gsproj` projects, `dotnet build`, `dotnet run`, templates, and SDK-side response-file invocation.
- VS Code extension and language server support for diagnostics, hover, definitions, references, symbols, formatting, completions, signature help, rename, code actions, code lens, semantic tokens, inlay hints, and debugging integration.
- Stable diagnostic IDs in the `GS####` form, with warning suppression and warning-as-error controls.

### Known pre-1.0 notes

- The language is still evolving; source compatibility may change before a stable release.
- Some surfaces are intentionally documented as current implementation behavior rather than final specification guarantees.
- The Playground page exists, but browser-hosted execution is deferred.

## Future release-note format

Use reverse chronological order. Each version entry should identify the version and, when a real release process exists, its date. Do not invent dates or version numbers; derive versions from the repository's release process.

```md
## X.Y.Z

Short summary of the release.

### Added

- New language, tooling, documentation, or interop capabilities.

### Changed

- Behavior changes, breaking changes, renamed features, or migration notes.

### Fixed

- Bug fixes, diagnostics corrections, emit or interpreter parity fixes, tooling fixes.

### Known issues

- Important limitations users should know before upgrading.
```
