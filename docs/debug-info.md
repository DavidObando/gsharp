# Portable PDB / debug information

GSharp emits standards-conformant [Portable PDB](https://github.com/dotnet/runtime/blob/main/docs/design/specs/PortablePdb-Metadata.md) symbols alongside its PE assemblies so external debuggers, profilers, and symbol indexers can map IL offsets back to GSharp source and surface meaningful stack traces.

This document is the source of truth for GSharp-specific identifiers and policies embedded in those symbols.

## Language GUID

GSharp registers a single, stable language GUID:

| Field | Value |
| --- | --- |
| Language | GSharp |
| Language GUID | `4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00` |
| Defined in | `src/Core/CodeAnalysis/Emit/PortablePdbEmitter.cs` (`GSharpLanguageGuid`) |

Every `Document` row written by the compiler carries this GUID in the `Language` column. External tools (debuggers, symbol servers, source indexers) that recognise GSharp source files **must** key off this value. Like the C# (`3F5162F8-07C6-11D3-9053-00C04FA302A1`) and F# (`AB4F38C9-B6E6-43BA-BE3B-58080B2CCCE3`) GUIDs, this value will never be reissued — even if the on-disk layout of GSharp source changes — so existing tooling never has to re-key.

## Hash algorithm

GSharp emits SHA-256 (`8829D00F-11B8-4213-878B-770E8597AC16`) document hashes. The same hash is also written into the PE CodeView entry once Phase 7 wires the debug directory, so symbol servers can verify the PE ↔ PDB pair by content.

## Sequence-point semantics

GSharp anchors sequence points at the *first IL offset emitted for each `BoundStatement`*. Lowered statements that originate from a single source statement collapse to one visible sequence point covering that source span; the synthesized scaffolding emitted between them is marked hidden (`0xfeefee`).

| Source construct | Sequence-point behaviour |
| --- | --- |
| `let` / `const` / `var` declarations | One visible point at the statement keyword. |
| Plain expression statements | One visible point at the expression. |
| `return expr` | One visible point at the `return` keyword. |
| `if` / `else` / loops | Visible point at each branch; the lowering's conditional gotos are hidden. |
| `for x in …` body | Visible points at the user-written body; the synthesized iterator handshake is hidden. |
| `defer { … }` | Visible points inside the deferred block; the finally-style scaffolding around it is hidden. |
| `async` / `await` | Visible points in user code; state-machine `MoveNext` prologue / dispatch / suspension is hidden. |
| Compiler-synthesized statements with no source | Hidden. |

This is the same visible/hidden contract Roslyn-emitted assemblies follow, so all standard .NET debuggers (Visual Studio, `vsdbg`, `netcoredbg`, `dotnet-dump`, JetBrains Rider, etc.) work without further configuration.

## Custom debug information

The Portable PDB writer is staged. Phase 4 (this milestone) emits only `Document` and `MethodDebugInformation` rows. The following are planned for subsequent phases and tracked separately:

* `LocalScope`, `LocalVariable`, `LocalConstant`, `ImportScope` — Phase 5.
* `EmbeddedSource`, `SourceLink`, `CompilationOptions`, `CompilationMetadataReferences` — Phase 6.
* PE `DebugDirectory` entries (`CodeView`, `PdbChecksum`, `Reproducible`, `EmbeddedPortablePdb`) — Phase 7.

## Compiler flags

The `gsc` compiler accepts the standard Roslyn-style debug flags:

| Flag | Meaning |
| --- | --- |
| `/debug[+/-]` | Equivalent to `/debug:portable` / `/debug:none`. |
| `/debug:none` | Suppress all debug information. |
| `/debug:portable` (alias `/debug:pdbonly`, `/debug:full`) | Emit a sidecar `*.pdb` next to the PE. |
| `/debug:embedded` | Embed the Portable PDB inside the PE's debug directory. |
| `/pdb:<path>` | Override the sidecar PDB output path. |
| `/sourcelink:<file>` | Embed the supplied Source-Link JSON as `CustomDebugInformation` (Phase 6). |
| `/deterministic[+/-]` | Emit a content-hash-based Mvid / PdbId. |

The SDK forwards `<DebugType>` and `<PdbFile>` through `BuildTask` so MSBuild-driven builds behave identically to direct `gsc` invocations.
