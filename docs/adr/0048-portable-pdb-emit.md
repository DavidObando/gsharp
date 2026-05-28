# ADR-0048: Portable PDB emit

- **Status**: Accepted
- **Date**: 2026-05-27
- **Phase**: Post-v1.0 enterprise-readiness
- **Related**: issues #95 (Portable PDB emit for `ReflectionMetadataEmitter`) and
  #50 (debugging: emit Portable PDBs alongside the PE); [ADR-0027 §7.7a](0027-roslyn-fork-decision.md);
  [`docs/debug-info.md`](../debug-info.md); [`docs/emit-pipeline.md`](../emit-pipeline.md).

## Context

GSharp's v1.0 emit pipeline produced PE assemblies but no debug information.
That gap blocked three enterprise scenarios:

1. **Stack traces.** `Exception.StackTrace` reported only IL offsets, with no
   `at <namespace>.<method>() in <file>:line` annotations. Customers
   investigating crash dumps from production GSharp services had to disassemble
   the PE to recover any source context.
2. **Live debugging.** Visual Studio, `vsdbg`, `netcoredbg`, JetBrains Rider,
   `dotnet-dump`, and every other PDB-aware tool could not set breakpoints,
   step through GSharp source, or inspect locals — the runtime had nothing
   mapping IL offsets back to `.gs` files.
3. **Symbol indexing.** Symbol servers (Microsoft Symbol Server, Azure
   Artifacts, JetBrains symbol server, internal mirrors) had no way to ingest
   GSharp builds because no PDB existed to publish.

[ADR-0027 §7.7a](0027-roslyn-fork-decision.md) had already committed to
delivering "full cross-language debugger support (Portable PDB, Source Link,
embedded sources)" by extending the bespoke emitter rather than by adopting
Roslyn. This ADR records the concrete design choices made while doing so —
specifically the small set of policy decisions that affect on-disk byte
layout, content identity, and SDK / CI behaviour, and that future readers
will need stable references for.

The bounding constraints were:

* **Standards conformance.** Whatever GSharp writes must validate against
  the [Portable PDB v1.0 specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/PortablePdb-Metadata.md)
  so existing debuggers and symbol servers consume it without bespoke
  awareness of GSharp.
* **No new runtime dependencies.** The PE writer already uses
  `System.Reflection.Metadata.Ecma335` directly. The PDB writer must follow
  suit so the emit pipeline stays Roslyn-free and the migration option
  ADR-0027 preserves is not eroded.
* **SDK convergence.** `Gsharp.NET.Sdk` must accept the same MSBuild
  property names (`<DebugType>`, `<DebugSymbols>`, `<EmbedAllSources>`,
  `<SourceLink>`, `<Deterministic>`) as `Microsoft.NET.Sdk` so mixed-language
  solutions can share a single `Directory.Build.props`.

## Decision

The Portable PDB emitter ships with the following fixed choices:

1. **Language GUID `4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00`.** Registered for
   GSharp, written on every `Document` row, and never reissued. Symbol
   servers, source indexers, and IDEs key off this value to recognise
   GSharp source.
2. **SHA-256 source hashes (`8829D00F-11B8-4213-878B-770E8597AC16`).** The
   same digest is used for the per-document hash in the PDB and for the
   `PdbChecksum` debug-directory entry in the PE. SHA-1 (the original
   Roslyn default) is not offered: every modern symbol server already
   accepts SHA-256 and several have begun rejecting SHA-1.
3. **Single root `ImportScope`, single flat `LocalScope` per method.**
   Reflects the current lowering, which flattens nested blocks. Per-file
   import chains and per-block scopes are deferred to follow-up work
   (#217) once the binder exposes the resolved `import` set on the
   symbol model; the deferral is byte-compatible (adding new
   `ImportScope` rows does not invalidate the rest of the PDB).
4. **`/debug:portable` as the default in `Debug`, `/debug:none` in
   `Release`.** Matches `Microsoft.NET.Sdk`. `<DebugType>embedded</DebugType>`
   is supported but never the default — embedded PDBs are larger and
   complicate symbol-server publishing pipelines.
5. **`/embed` (source embedding) is opt-in, off by default.** Embedding
   source bytes into the PDB makes debugging robust to source-tree
   movement but bloats the PDB and, more importantly, would ship internal
   source into anything published from the build. Customers opt in via
   `<EmbedAllSources>true</EmbedAllSources>` or `/embed+`. The
   recommendation in [`debug-info.md`](../debug-info.md) is to combine
   `<EmbedAllSources>` with `<DebugType>embedded</DebugType>` only for
   builds you are deliberately publishing as self-contained for
   third-party debugging.
6. **`/deterministic` produces a content-hash MVID, PDB content-id, and a
   `Reproducible` debug-directory entry.** Reproducible builds are a
   prerequisite for Source Link, package validation, and SBOM tooling.
   The non-deterministic path (fresh `Guid.NewGuid()` MVID) is preserved
   only for local incremental builds where rebuild detection on content
   hash would be counterproductive.
7. **`PdbChecksum` and shared `CodeView.Guid` are always written when
   debug info is on.** Same 32-byte SHA-256 of the serialised PDB blob;
   same GUID as the PDB metadata header's `Id`. Symbol servers verify
   PE↔PDB pairing by checksum without needing both files side-by-side.
8. **`CompilationOptions` is always emitted (cheap, ~80 bytes).** Carries
   `compiler-name=gsc`, `compiler-version`, `language=GSharp`,
   `language-version=1.0`. Source-Link-aware debuggers and SBOM tools
   read this to identify the producer.

The collaboration shape is:

```csharp
// Compilation.EmitAssembly
var pdb = new PortablePdbEmitter(debugInfo);
var emitter = new ReflectionMetadataEmitter(metadataBuilder, ilStream, pdb, ...);
// ... emit types/methods; ReflectionMetadataEmitter calls
//     pdb.GetOrAddDocument(tree) and pdb.RecordMethod(...) inline ...
var (pdbBlob, pdbContentId) = pdb.Serialize(...);
peBuilder.DebugDirectoryBuilder.AddCodeViewEntry(pdbFileName, pdbContentId, ...);
peBuilder.DebugDirectoryBuilder.AddPdbChecksumEntry("SHA256", SHA256.HashData(pdbBlob));
if (deterministic) peBuilder.DebugDirectoryBuilder.AddReproducibleEntry();
if (embedded)     peBuilder.DebugDirectoryBuilder.AddEmbeddedPortablePdbEntry(pdbBlob, version: 0x0100);
```

The full byte-layout reference, sequence-point semantics, compiler-flag
table, and SDK property mapping are documented in
[`docs/debug-info.md`](../debug-info.md). The end-to-end pipeline diagram
and component list live in [`docs/emit-pipeline.md`](../emit-pipeline.md).

## Consequences

**Positive**

* `Exception.StackTrace` from a `gsc`-compiled assembly now cites the
  original `.gs` file and line, indistinguishable from C#- or F#-emitted
  assemblies. Verified end-to-end by `test/Compiler.Tests/Acceptance/StackTraceTests.cs`.
* Visual Studio, `vsdbg`, `netcoredbg`, JetBrains Rider, and `dotnet-dump`
  set breakpoints, step through GSharp source, and inspect locals
  without configuration. Live-debugger coverage validated by
  `build/debugger-e2e.sh`.
* Symbol servers ingest GSharp builds with the same publishing scripts
  used for C#: PE + sidecar PDB pair (or embedded PDB) with a
  `PdbChecksum` for verification. Source Link is a one-property opt-in
  (`<SourceLink>../sourcelink.json</SourceLink>`).
* SBOM and supply-chain tooling can identify the producer via the
  `CompilationOptions` blob without inferring from filename heuristics.
* Reproducible-build verification (Microsoft package validation, F-Droid-
  style rebuild checks) works against GSharp assemblies — the same
  source produces a byte-identical PE+PDB pair.

**Negative**

* Adds ~10–25% to total emit time for typical projects (PDB serialisation
  + SHA-256 over the PDB blob). The cost is unavoidable; competing PDB
  writers (Roslyn, F#) pay essentially the same overhead.
* The GSharp language GUID is permanently allocated. Any future fork or
  re-implementation of the language must either honour it or coordinate
  a new GUID with downstream tooling.
* Embedded PDBs increase PE size and are harder to strip post-hoc. The
  off-by-default choice mitigates accidental shipment of debug info into
  release artefacts.

**Neutral**

* The PE↔PDB pairing checksum is SHA-256, not SHA-1. Symbol servers
  that have not yet enabled SHA-256 ingestion (very few remain) will
  reject GSharp PDBs until they upgrade. We treat this as a forcing
  function rather than a regression.

## Alternatives considered

* **Skip PDBs for v1.0 and recommend interpreter execution for debug
  scenarios.** Rejected: the interpreter is not a substitute for live
  cross-language debugging, and crash-dump diagnostics in production
  cannot use the interpreter at all. This was the de-facto v1.0 state
  and the gap drove issues #95 / #50.
* **Adopt Roslyn's `PdbWriter` via reference.** Rejected by [ADR-0027](0027-roslyn-fork-decision.md):
  v1.0 closes the Roslyn-fork track and grows the bespoke emitter
  instead. The Portable PDB primitives we need
  (`PortablePdbBuilder`, `DebugDirectoryBuilder`,
  `MethodDebugInformation`, `LocalScope`, `Document`,
  `CustomDebugInformation`) are all in `System.Reflection.Metadata`
  itself, so no Roslyn surface is required.
* **Default `/debug:embedded` to simplify deployment.** Rejected:
  larger PEs, no public symbol-server pipeline, and indistinguishable
  from "shipped with sources" without inspecting bytes. Sidecar PDBs
  match the modern .NET default and make Source-Link / symbol-server
  workflows trivial.
* **Default `/embed+` to make debugging robust.** Rejected for the same
  reason F# and C# default it off: it embeds source bytes into a
  routinely-shipped artefact, which is rarely what the author wants.
  Opt-in covers the cases where it is.
* **Write a Windows PDB (`.pdb` MSF) instead of Portable PDB.** Rejected:
  Windows-only, requires `Microsoft.DiaSymReader.Native`, no Source-Link
  story, no embedded-source story, and no platform-agnostic ingest path.
  Portable PDB is the contemporary default for every .NET language.
