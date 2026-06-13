---
title: "Release notes"
draft: false
---

# Release notes

G# is pre-1.0. The repository's version base is currently `0.1`, and product versions are derived by Nerdbank.GitVersioning from that base and the Git commit. Until the project reaches a stable compatibility promise, release notes should be read as implementation status notes rather than a long-term compatibility contract.

## Unreleased

The G# compiler, language server, and VS Code extension absorbed a large stack of additions this cycle. The summary below groups them by area; each item links to the design decision (ADR) or implementation reference.

### Added

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
- Nullable `T?` types with `nil`, `?.`, `?:`, and `!!`.
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
