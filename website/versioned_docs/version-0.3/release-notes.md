---
title: "Release notes"
draft: false
---

# Release notes

G# is pre-1.0. The repository's version base is currently `0.3`, and product versions are derived by Nerdbank.GitVersioning from that base and the Git commit. Until the project reaches a stable compatibility promise, release notes should be read as implementation status notes rather than a long-term compatibility contract.

## 0.3

The third pre-1.0 line is a **breadth-and-interop** release. The language gains a large batch of C#-parity expression and declaration constructs, an `unsafe` pointer surface, `partial` types, and anonymous-object literals. Tooling adds the `cs2gs` C#→G# migration tool and the `gsgen` Roslyn source-generator host for native G# projects. The language server gains incremental binding, an incremental semantic-model pipeline, and a cross-session cold-start cache. This release also cuts a fresh `0.3` docs snapshot from the live docs and retires the `0.2` snapshot.

### Highlights

- **Unsafe pointer surface.** An `unsafe` context now supports unmanaged raw pointers `*T`, `stackalloc [n]T` producing either safe `Span[T]` or unsafe `*T` storage, the `fixed` pinning statement, the `unmanaged` type-parameter constraint, `sizeof(T)`, and pointer compound-assignment and cast lowering.
- **New expression and statement forms.** Throw expressions, value-producing increment and decrement expressions `++` / `--`, from-end indexes `^n`, standalone `System.Range` values such as `1..3`, expression-bodied members via `->`, general `goto` / labels, collection initializers `List[T]{…}` / `HashSet[T]{…}` / `Dictionary[K,V]{…}`, and inferred-type arrow lambdas with statement-block bodies.
- **New declaration forms.** `partial` classes, structs, and interfaces; anonymous-object literals `object { … }`; nested type declarations; user-defined conversion operators `operator implicit` / `operator explicit`; user indexer members `prop this[i int32] T { get; set }`; the `shared { init { … } }` static-initializer block; static imports through `import Ns.Type`; and top-level `private` mapping to IL `assembly` / internal.
- **`cs2gs` C#→G# migration.** The new translator lowers C# source to canonical G#, with construct coverage, gap triage, and a build-time strategy that reproduces generated code rather than freezing it. See the new [cs2gs tooling page](./tooling/cs2gs.md).
- **Source generators for native G#.** The `gsgen` host runs Roslyn analyzers and generators against native G# projects. `gsc /analyzer:<asm>` spawns `gsgen` as a sibling before compiling. A shared resx codebehind generator emits `Resources.Designer.gs`.
- **Language-server performance.** Incremental binding, instance-keyed semantic-model memoization, a cross-session cold-start cache, completion-as-you-type triggering, and unified member resolution reduce repeated work across binder and LSP flows.
- **Diagnostics catalogue extended.** v0.3 adds diagnostics through the `GS04xx` range. The [Diagnostics reference](./ref/diagnostics.md) is reconciled against the compiler source and lists the current per-ID cause and fix detail.

### Added

- **Null-coalescing operator respelled `??`.** The null-coalescing operator is `a ?? b`. The earlier `?:` spelling is retired in that role; `cond ? a : b` remains the ternary expression.
- **Runtime array allocation `[n]T`.** A length-bearing `[n]T` allocates a zero-initialised array at runtime, complementing array literals.
- **Nullable array-element spelling.** `[]T?` is an array of nullable elements; `[]?T` is a nullable array.
- **Nullable function-type spelling.** Nullable function types are spelled and displayed with the appropriate parenthesisation.
- **Expression-tree lambda conversions.** A lambda converts to `Expression[TDelegate]` where the target demands an expression tree.
- **Delegate return-type covariance.** Delegate return types can be covariant, including lambda target-typing on CLR method calls.
- **Predefined type aliases as static-member receivers.** Friendly numeric aliases can be used as receivers for static member access.
- **Assembly-attribute parity with C#.** Assembly-level attributes are accepted with C#-equivalent behavior.

### Changed

- **C#-compatible numeric conversions.** Numeric literal narrowing and widening, plus implicit numeric promotion at call sites, now align with C# behavior.
- **Unannotated imported reference types are nullable by default.** Imported reference types without nullable annotations bind as nullable.
- **`char` bitwise and shift operators promote to `int32`.** Enum `==` / `!=` comparisons against the integer literal `0` are also permitted.
- The website spec, feature matrix, diagnostics reference, CLR-interop reference, guides, tour, tutorials, and tooling docs were refreshed to match compiler ground truth for the 0.3 surface; a new `cs2gs` tooling page was added.
- The Docusaurus site cuts a new `0.3` snapshot from the live docs and retires the `0.2` snapshot. The version dropdown lists `0.3` and `Next`.

### Fixed

- Extensive `cs2gs` translator hardening across nullability promotion, extension-call lowering, deconstruction and indexer targets, pattern binding, named-argument lowering, and source-generator-shaped constructs.
- Numerous `gsc` binder, emitter, and interpreter correctness fixes across imported generic interface methods, nullable value-tuple boxing, `data class` equality and `with`, overload resolution, async lambda inference, and smart-cast narrowing.

### Known limitations

- `gsc --help` advertises `/implicitimports[+|-]`; the `+` / `-` suffix form is not currently accepted by the Release parser. Use `/noimplicitimports`.
- Migration coverage in `cs2gs` is still expanding. C# source generators are reproduced at build time rather than translated, and some constructs remain on the gap-triage backlog.

## 0.2

The second pre-1.0 line is a syntax-and-ergonomics release. The parser, binder, and emitter absorb substantial additions; several legacy Go-flavored spellings are retired in favour of canonical G# forms; and the native-interop and default-interface-method surfaces ship end-to-end. This release also formally introduces docs versioning: the `0.1` snapshot is removed and a fresh `0.2` snapshot is cut from the live docs.

### Highlights

- **New language surface.** `while` / `do…while` loops with labeled `break` / `continue`; `if let` / `guard let` smart-cast bindings; null-coalescing compound assignment `??=`; null-conditional indexing `a?[i]`; arrow lambdas `x => body`; canonical `(T1, T2) -> R` function-type clauses; lambda binding-type inference; Kotlin/Swift-style type-declaration grammar; if-as-expression completion; smart-cast extensions; discriminated-union enum payloads; `default(T)` and target-typed bare `default`; variadic `...T` parameters in function and anonymous function-type clauses; `class` / `struct` / `init()` constraint flag spellings; default-interface methods; reified generics; `Gsharp.Extensions.Optional` and `Gsharp.Extensions.Sequences`; friendly numeric type aliases; and the canonical map type clause `map[K,V]`.
- **Removals and migrations.** Legacy spellings now produce focused, span-accurate diagnostics with canonical replacements so IDE quick-fixes can patch most migrations in one edit.
  - `type` keyword for type declarations (`type Foo struct { … }` → `struct Foo { … }`).
  - `record` keyword, replaced by `data class` or `data struct`.
  - `:=` short variable declaration, replaced by `let` / `var`, with diagnostic `GS0305`.
  - `name = value` named-argument separator, replaced by `name: value`, with diagnostic `GS0315`.
  - `func(T) R` legacy function-type clause, replaced by `(T) -> R`, with diagnostic `GS0303`.
  - Go-flavored `map[K]V` type clause, replaced by `map[K,V]`, with diagnostic `GS0366`.
  - `static func` on interface methods is removed. Static-virtual interface members now live inside the interface `shared { … }` block. A body-less `func` inside that block is an abstract static-virtual slot; a `func` with a body is the default. Static private helpers also move into the `shared { … }` block as `private func`, while instance private helpers stay directly in the interface body. The old `static func …` shape now produces a parser error, and `GS0330` fires when a non-`func` member appears inside an interface `shared { … }` block.
- **Body-less `func` now requires `;`.** A `func` declaration without a `{ … }` block is terminated by the universal no-body marker `;`. This already held for P/Invoke (`func getpid() int32;`) and now also applies to abstract interface methods and abstract static-virtual slots inside an interface `shared { … }` block. A body-less interface `func` missing its `;` reports `GS0368`; a `func` carrying a body still takes no `;`.
- **Native interop end-to-end.** P/Invoke via `@DllImport`, source-generator-shaped `@LibraryImport`, struct and class marshalling, `ref` / `out` / `in` parameter marshalling, function-pointer marshalling, and `@MarshalAs` parameter overrides are supported.
- **Go-flavored concurrency moved behind an opt-in import.** `go`, `chan`, `select`, channel send and receive, `make(chan T)`, and the built-ins `len`, `cap`, `append`, `make`, and `delete` now require `import Gsharp.Extensions.Go`. Diagnostics `GS0316` / `GS0317` point at the missing import.
- **Tooling polish.** LSP completion understands async-shaped types such as `async (T) -> R` and `async sequence[T]`; `textDocument/codeAction` offers nil-related quick fixes; and `null` now produces a `nil` "did you mean" diagnostic `GS0273`.
- **Diagnostics catalogue extended.** v0.2 introduces `GS0273` and `GS0288`–`GS0366`. The [Diagnostics reference](./ref/diagnostics.md) has the per-ID cause and fix detail.

### Added

- **Friendly numeric type aliases.** `int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, and `double` are accepted everywhere a type name is accepted, as a strict superset on top of the canonical width-bearing names (`int32`, `uint32`, …). The alias resolves to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, `nameof`, hover, and emitted IL always print the canonical spelling. Canonical names remain preferred in documentation and public library APIs; aliases are appropriate inside function bodies and local code. Aliases are reserved type names, so `type int = string` and equivalents are rejected with `GS0102`.
- **Null-conditional indexing `a?[i]`.** `a?[i]` evaluates receiver `a` exactly once. If it is `nil`, the whole expression yields `nil`; otherwise the result is the indexed value lifted to the nullable form of the indexer's return type. It works on arrays, slices, maps, and CLR indexers on both emit and interpreter paths. Chained forms (`h?.Data?[i]?.c`) short-circuit on the first nil. The new token `?[` is recognized only when `[` immediately follows `?`, preserving `cond ? [arr] : [arr]` ternary parses. Diagnostics `GS0300` and `GS0301` cover non-nullable receivers and assignment left-hand sides.
- **Documentation comments.** Markdown-authored `///` documentation comments round-trip losslessly to CLR XML doc. Hover renders merged documentation for both G# declarations and imported CLR APIs. New warnings include `GS0227`, `GS0228`, `GS0229`, `GS0230`, and `GS0231`.
- **Named delegate types.** `type Name = delegate func(...)` declares a real CLR `MulticastDelegate`-derived type so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types. Diagnostics `GS0233`–`GS0234` cover invalid forms.
- **`ref` / `out` / `in` parameters.** Declaration-site and call-site ref-kind modifiers are supported, including inline `out var` / `out let` / `out _` declarations. Diagnostics `GS0235`–`GS0243` cover the rules. Passing a value to an `in` parameter without writing `in` at the call site is warning `GS0242` rather than a silent spill.
- **Ref-aliasing locals.** `let ref m = arr[i]` and `var ref v = c.Field` produce locals whose IL slots are `T&` and alias another lvalue. Diagnostics `GS0256`–`GS0258` cover invalid aliases.
- **Ref returns.** `func f(...) ref T { return ref <expr> }` is supported. Diagnostics `GS0248`–`GS0255` cover escape rules, async and iterator bans, and override matching.
- **Conditional ref-arguments.** The narrow `ref cond ? a : b` form is supported inside ref-kind argument payloads. Diagnostics `GS0260`–`GS0262` cover invalid forms.
- **Generalized ternary expression.** `cond ? a : b` is now a normal expression. `GS0259` is retired in value contexts; `GS0263` covers "no common type" failures.
- **Method overloading and optional parameters.** User G# functions can carry overload sets that differ by parameter types or ref-kinds, and optional parameters can use compile-time-constant defaults. Diagnostics `GS0264`–`GS0267` cover invalid overloads and defaults.
- **Named arguments at call sites.** `Foo(timeout: 30, retries: 3)` works for free functions, user methods, user constructors, extension functions, inherited CLR methods, and delegate `Invoke`. Diagnostics `GS0244`–`GS0247` cover invalid usage. The legacy `name = value` form is deprecated this release with diagnostic `GS0315`; migrate `.copy(...)` and attribute argument lists alongside ordinary call sites.
- **`scoped` parameter modifier.** `scoped` constrains a `ref struct` or managed-pointer parameter from escaping, enforced by `GS9004` / `GS9006`.
- **`data struct` synthesis completed.** Every `data struct` synthesizes `Equals(object)`, `Equals(T)`, `GetHashCode()`, `ToString()`, `op_Equality`, `op_Inequality`, and `Deconstruct(...)`. Hand-written versions are rejected with `GS0232`.
- **Editor features.** Hover for CLR XML docs, live pull-based diagnostics, CodeLens reference counts on members of structs, interfaces, and enums, implicit `this` for properties, methods, and events, hover for `this`, bare static-member access from instance methods, chained-member hover, and six VS Code color themes inspired by the G# logo: Ember, Magma, and Synthwave in dark and light variants.
- **`:=` short variable declaration removed.** Every binding site now requires `let` for immutable bindings or `var` for mutable bindings. The lexer still recognizes `:=` so the parser can emit `GS0305` with context-sensitive migration suggestions such as `x := 1` → `let x = 1`, `for i := 0 ... 10` → `for i in 0 ... 10`, and `case v := <-ch` → `case let v = <-ch`.

### Changed

- The website spec, feature matrix, FAQ, bridges page, guide pages, and design-decisions index were refreshed to match compiler ground truth. Outdated statements such as "Parameters do not have default-value syntax" and "Named arguments — Partial" were rewritten.
- The repo `docs/lexical.md` block-comment paragraph is corrected, and a documentation-comments subsection was added.
- The VS Code TextMate grammar adds contextual keywords (`data`, `inline`, `record`, `delegate`, `event`, `prop`, `init`, `shared`, `scoped`, accessor names `get` / `set` / `add` / `remove` / `raise`, and ref-kinds `ref` / `out`), operators (`:=`, `?.`, `??`, `?` / `:`, `!!`, `...`, `=>`), an `@Annotation` scope, and a `///` documentation-comment scope with `@tag` highlighting. The VS Code snippet set was rewritten to match current grammar.
- The Docusaurus site cuts a new `0.2` snapshot from the live docs and retires the `0.1` snapshot. The version dropdown lists `0.2` and `Next`; the `0.1` URL space is no longer served.

### Fixed

- Numerous IL-emit, determinism, language-server, and editor hardening rounds improve CLR verification, byte-for-byte reproducibility, property access, CodeLens accuracy, and stale-tree handling.

### Known limitations

- Full ref-safe-to-escape analysis is partial; `GS0257` is reserved for a future pass.
- Unsupported async state-machine emit shapes continue to report `GS0190`.

## 0.1

The `0.1` version base identifies the first pre-1.0 line. This is not a dated stable release announcement; it summarizes the major capabilities implemented in the repository at that point.

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
- VS Code extension and language server support for diagnostics, hover, definitions, references, symbols, formatting, completions, signature help, rename, code actions, CodeLens, semantic tokens, inlay hints, and debugging integration.
- Stable diagnostic IDs in the `GS####` form, with warning suppression and warning-as-error controls.

### Pre-1.0 notes

- The language is still evolving; source compatibility may change before a stable release.
- Some surfaces are intentionally documented as current implementation behavior rather than final specification guarantees.
- The Playground page exists, but browser-hosted execution is deferred.

## Future release-note format

Use reverse chronological order. Each version entry should identify the version and, when a real release process exists, its date. Do not invent dates or version numbers; derive versions from the repository's release process. Write for end users: describe what changed, what it means, and any migration steps they should take.

```md
## X.Y.Z

Short summary of the release.

### Added

- New language, tooling, documentation, or interop capabilities users can try.

### Changed

- Behavior changes, breaking changes, renamed features, or migration notes.

### Fixed

- Short grouped quality notes for user-visible correctness, diagnostics, emit, interpreter, or tooling improvements.

### Known limitations

- Important limitations users should know before upgrading.
```
