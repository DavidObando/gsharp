---
title: "Release notes"
draft: false
---

# Release notes

G# is pre-1.0. The repository's version base is currently `0.1`, and product versions are derived by Nerdbank.GitVersioning from that base and the Git commit. Until the project reaches a stable compatibility promise, release notes should be read as implementation status notes rather than a long-term compatibility contract.

## Unreleased

This documentation set is the initial public documentation release for the G# website. The language and tooling are under active development, so future entries should call out breaking changes clearly and link to the relevant design decision or reference page.

### Added

- Authored public documentation pages for the FAQ and release notes.
- Established this page as the release-history location for future G# documentation updates.

### Changed

- No runtime or language change is implied by this documentation entry.

### Fixed

- No product fixes are recorded in this documentation entry.

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
