# ADR-0027: Roslyn-fork decision for v1.0 — stay on the bespoke emitter

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 7 (execution plan §7.7)
- **Related**: issue [#51](https://github.com/DavidObando/gsharp/issues/51) (Roslyn-fork track), issue [#52](https://github.com/DavidObando/gsharp/issues/52) §3.5, `docs/emit-pipeline.md`, ADR-0023 (async state machine), ADR-0028 (multi-package emit)

## Context

By the end of Phase 7, GSharp has six phases of operating experience with the bespoke `ReflectionMetadataEmitter` (`src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs`, ~4 500 lines), which writes ECMA-335 PEs directly via `System.Reflection.Metadata.Ecma335`. The vendored Roslyn tree under `src/Roslyn` has never been wired into the compiler pipeline; `Compilation.cs` still carries a stub comment pointing at the "pure-Roslyn-subclass backend" as a long-term option. Issue #51 keeps the fork option open and enumerates four triggers that would force a reconsideration: cross-assembly semantic-model interop with Roslyn analyzers, IDE design-time parity through shared Roslyn workspaces, source-generator authoring _in_ GSharp as a peer language inside the Roslyn driver, and shared metadata-import infrastructure at scale.

Two ecosystem requirements drive this decision point and were explicitly called out as v1.0-blocking:

1. **NuGet-distributable GSharp libraries that are consumable from other .NET languages** (C#, F#) without surprises in metadata shape, visibility, attributes, or reference-assembly contracts.
2. **Full debugger support with source/symbol references**, sufficient for a single solution that mixes a GSharp library and a C# (or F#) front end to single-step across the language boundary, hit breakpoints in both languages, inspect locals, and see source on both sides of every frame.

Neither requirement appears on the issue #51 trigger list, and both are pure ECMA-335 + Portable-PDB problems whose APIs (`MetadataBuilder`, `PortablePdbBuilder`, `DebugDirectoryBuilder`, `BlobBuilder`, `MethodDebugInformation`, `LocalScope`, `Document`, `CustomDebugInformation`) are available out-of-the-box in `System.Reflection.Metadata` — the same surface Roslyn itself uses internally. Mixed-language stepping between F# and C# in Visual Studio / VS Code / `dotnet` already works precisely because both compilers emit the same standard Portable-PDB tables; nothing in that contract is private to Roslyn.

## Decision

GSharp v1.0 ships on the bespoke `ReflectionMetadataEmitter`. Issue #51 is **closed as `wontfix` for v1.0**, with a note that revival remains possible if any of its four triggers materialises after v1.0. The vendored `src/Roslyn` tree is scheduled for removal in a follow-up PR; until then it is documented as inactive and excluded from the default build graph (it already is — `GSharp.sln` does not include it).

In parallel, two engineering work items move onto the Phase 7 backlog so that the two v1.0 ecosystem requirements are satisfied on the bespoke path:

- **7.7a — Portable PDB emit.** Extend `ReflectionMetadataEmitter` to emit a standalone Portable PDB (and honour `/debug:embedded` by embedding it in the PE), populate `Document` / `MethodDebugInformation` / `LocalScope` / `LocalVariable` / `LocalConstant` / `ImportScope` / `CustomDebugInformation` (kind = `EmbeddedSource`, `SourceLink`, `CompilationOptions`, `CompilationMetadataReferences`), and write a `DebugDirectory` with a CodeView entry plus a PDB-checksum entry. Acceptance gate: an E2E test under `build/` that builds a GSharp library, a C# console exe referencing it, launches `dotnet` under `vsdbg` / `netcoredbg`, sets a breakpoint inside the GSharp library, and asserts the debugger stops with the correct source file, line, and local-variable names visible.

- **7.7b — NuGet packaging path for `.gsproj`.** Add `Pack` target wiring to `Gsharp.NET.Sdk`, drive ref-assembly emit through the existing `metadataOnly` flag, lay the output out as `lib/<tfm>/*.dll` + `ref/<tfm>/*.dll` + `*.xml` + Source-Link `*.snupkg`, and emit the cross-language interop attributes that GSharp semantics imply (`ExtensionAttribute`, `IsReadOnlyAttribute`, `NullableAttribute`/`NullableContextAttribute`, `RequiresPreviewFeaturesAttribute`, `InternalsVisibleToAttribute`, `AssemblyInformationalVersionAttribute`, `AssemblyMetadataAttribute`). Acceptance gate: an E2E test that `dotnet pack`s a GSharp library, consumes the resulting `.nupkg` from a vanilla C# `dotnet new console`, and from a vanilla F# `dotnet new console`, exercising public types, methods, extension functions, `data struct` equality, and an `inline struct` newtype.

Both work items are bounded, well-scoped against the existing emitter, and have no dependency on the Roslyn fork.

## Rationale

The Roslyn-fork option exists to provide capabilities that GSharp cannot otherwise obtain — primarily, exposing GSharp symbols as `ISymbol` to Roslyn-based tooling, and hosting GSharp inside the Roslyn driver as a peer language. NuGet distribution and a cross-language debugger experience are not in that capability set. They are products of emitting standards-compliant ECMA-335 metadata and standards-compliant Portable PDBs, both of which are first-class non-Roslyn surfaces in `System.Reflection.Metadata`. F# is the existence proof: `FSharp.Compiler` does not derive from `Microsoft.CodeAnalysis.Compilation`, yet F# libraries pack into NuGets and step cleanly under a C# debugger because the Portable-PDB and metadata contracts are the contract.

The bespoke emitter has also earned its place across six phases (1 through 7.6) with no architectural escape valve required. The escape valves that Phase 4 (generics consumption), Phase 5 (async state machine — ADR-0023), Phase 6 (interfaces, extensions, NRT), and Phase 7.4 (inline value classes) anticipated have all been resolved inside `System.Reflection.Metadata` without reaching for Roslyn-derived infrastructure. The remaining v1.0 ergonomic targets (`defer` lowering, `for x in collection`, `data struct` polish, templates, LSP polish) are all _front-end_ or _lowering_ work that does not interact with the choice of metadata writer.

Taking the Roslyn fork at this point would be a strictly negative trade: it would import a multi-million-line dependency with its own build, branding, and rebasing burden; force a parity migration of every bound-node → IL mapping already encoded in the bespoke emitter; and require maintaining a fork-tracking discipline against `dotnet/roslyn`'s `main`. None of that purchases NuGet distribution or debugger support — they are obtained on the current path for substantially less code.

## Consequences

### What stays the same

- Single emit pipeline (`Lexer → Parser → Binder → Lowerer → ReflectionMetadataEmitter`) remains documented in `docs/emit-pipeline.md` as the production path.
- No `Microsoft.CodeAnalysis` runtime dependency in `gsc`, no Roslyn assembly load on startup, no fork-rebasing cycle.
- `Gsharp.NET.Sdk` retains its current shape (`tools/task` + `tools/compiler` layout) and gains a `Pack` target rather than a Roslyn-based compiler swap.

### What gets unlocked by 7.7a + 7.7b

- A user can `dotnet new gsharp-lib`, add public types, `dotnet pack`, and the resulting `.nupkg` is consumable from `dotnet add package` in C# and F# projects. Public surface is correctly typed, equality semantics for `data struct` and `inline struct` are observable, extension functions are discoverable, and IDE IntelliSense lights up because XML docs and reference assemblies ship in the package.
- A multi-project solution containing a GSharp library and a C# (or F#) front end debugs as one program: breakpoints in `.gs` files hit, locals show real names, stepping into GSharp code from a C# call site lands on the right source line, async stack traces stitch across the language boundary because state-machine debug info is written into the PDB.
- Source Link makes GSharp library code navigable from a consumer's debugger even when only the NuGet is available, matching the experience of every other modern .NET language.

### What we explicitly forgo (and accept) by closing #51 for v1.0

- **GSharp symbols are not `ISymbol`.** Roslyn analyzers, code-fix providers, refactoring providers, and incremental source generators that introspect references via the Roslyn semantic model see a referenced GSharp assembly as a `MetadataReference` only. They can read its public surface (types, methods, attributes) the same way they read any other compiled assembly, but they cannot walk a GSharp _syntax tree_ or get back a GSharp-aware `SemanticModel`. This is acceptable for v1.0: GSharp consumers will run Roslyn analyzers against their C#/F# code that _uses_ GSharp libraries; they will not run Roslyn analyzers against the GSharp source itself (GSharp's own LSP — Phase 7.5 — owns that surface).
- **No shared Roslyn workspace.** A Visual Studio solution that mixes GSharp and C# does not get cross-language "Find All References" or "Rename" inside the Roslyn workspace. The LSP can simulate the user-facing experience for GSharp-resident features; cross-language refactoring across the boundary remains aspirational. Users who need it can drop down to text search across the solution, which is the same answer F# users have today.
- **No in-GSharp source generators.** A GSharp project cannot author a `IIncrementalGenerator` that participates in the Roslyn driver. Code generation _into_ a GSharp project from a Roslyn source generator authored in C# still works at the project-system level (the generator emits C# code into a sibling C# project that the GSharp project references), but the inverse is not supported.
- **No shared metadata-import infrastructure at scale.** GSharp continues to import reference assemblies through `MetadataLoadContext` and `ReferenceResolver` rather than through Roslyn's `PEAssembly`/`PEModule`. This has been sufficient for Phases 1–7; if a future feature (e.g., generic-attribute introspection over deeply nested ref-readonly returns with custom modifiers) hits a wall, that is the trigger to reopen #51, not v1.0 release.
- **No "Roslyn pays for it for free" features.** Deterministic emit, ref-assembly generation, embedded PDB, Source Link, public-key-token strong naming, and InternalsVisibleTo emit are all engineering work in the bespoke path. Each is well-bounded, has shipping precedent (every non-Roslyn .NET tool that writes metadata has solved them), and is scoped into 7.7a/7.7b above.

If any of these forgone capabilities later become a release blocker, the path back to #51 is preserved: the vendored `src/Roslyn` tree can be re-introduced, and the bespoke emitter can remain behind a feature flag during migration (as #51 already prescribes). Closing #51 today is not the same as deleting the option permanently; it is choosing not to spend Phase 7 on infrastructure that is not on the critical path for v1.0.

### Engineering cost summary

| Capability | Bespoke path (chosen) | Roslyn-fork path (rejected for v1.0) |
| --- | --- | --- |
| NuGet pack of `.gsproj` | One Phase-7 work item (7.7b) on top of existing `metadataOnly` mode | Same work item, plus migration of the entire emitter to `PEModuleBuilder` first |
| Cross-language debugger / Portable PDB | One Phase-7 work item (7.7a) using `System.Reflection.Metadata` | Inherited from `PEModuleBuilder`, but predicated on completing the entire fork migration |
| Roslyn `ISymbol` interop | Not delivered | Delivered (this is the fork's reason to exist) |
| Source generators authored in GSharp | Not delivered | Delivered eventually |
| Shared Roslyn workspace / IDE parity | Approximated via LSP | Delivered eventually |
| Maintenance burden | Owned 4 500-line emitter | Multi-million-line vendored Roslyn tree + ongoing rebase against `dotnet/roslyn` |

## Alternatives considered

**Revive #51 now and migrate emit to a Roslyn-derived `GsharpCompilation` / `PEModuleBuilder` for v1.0.** Rejected. The two v1.0-blocking ecosystem requirements (NuGet, debugger) do not need it; the fork's distinctive capabilities (analyzer interop, source-generator hosting, shared workspaces) are not on the v1.0 critical path; and a Phase-7 migration would absorb roadmap budget that is already assigned to LSP polish, templates, defer/using lowering, and `for x in collection`. The migration cost is also asymmetric: if we migrate to Roslyn we cannot easily move back, whereas postponing the migration leaves the bespoke emitter intact and the fork option open.

**Hybrid: keep the bespoke emitter for IL, but add a thin Roslyn-derived `Compilation` shim that exposes GSharp symbols as `ISymbol` for analyzer interop.** Rejected for v1.0. A faithful `ISymbol` projection is most of the cost of the full fork (the `SourceAssemblySymbol`/`SourceMethodSymbol` layer in #51's `p1-symbols` scope), and shipping a partial projection that lies about constructs Roslyn analyzers expect (e.g., property accessors, partial methods, conversion operators) would be worse than not shipping one at all. If real demand for analyzer interop appears post-v1.0, the full #51 scope is the right answer.

**Delete `src/Roslyn` outright as part of this ADR.** Deferred to a follow-up. The tree is large and its removal touches `.gitmodules` and CI; it is best handled in a dedicated PR so the diff is reviewable. Until then, the tree stays in the repo, excluded from `GSharp.sln`, and documented as inactive in `docs/emit-pipeline.md`.

**Ship NuGet packaging and PDB emit through Roslyn _only_ (no migration of the emitter itself), by re-emitting bound trees as Roslyn syntax and letting Roslyn write the PE.** Rejected. This is strictly more work than 7.7a + 7.7b (full bound-tree → CSharpSyntax translation, with all the impedance mismatches), introduces a translation layer that has to track every new GSharp construct, and would couple the GSharp release cadence to a Roslyn package version.
