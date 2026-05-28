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

## Local-scope semantics (Phase 5)

GSharp's lowering pipeline flattens all nested `BoundBlockStatement`s into a
single, top-level block before IL emit, so the compiler currently emits one
`LocalScope` per method covering the entire body (`StartOffset = 0`,
`Length = method.GetILBytes().Length`). Every user-declared local is recorded
as a `LocalVariable` row anchored at its IL slot and tagged with its source
name; compiler-synthesized locals (names starting with `<`, `$`, or containing
`$`) are emitted with `LocalVariableAttributes.DebuggerHidden` so debuggers
keep them out of the locals window.

A single root `ImportScope` row is emitted per assembly and referenced by
every `LocalScope`. Per-file import chains land in a later phase once the
binder exposes the resolved `import` set on the symbol model.

The `MethodDebugInformation` sequence-point header now carries the real
`LocalSignatureToken` for each method body, so debuggers can decode the
on-stack values at every sequence point against the same `StandAloneSig`
row used by the IL itself.



The Portable PDB writer is staged. Phases 4–5 (shipped) emit `Document`,
`MethodDebugInformation`, `LocalScope`, `LocalVariable`, and a single root
`ImportScope` row per assembly. The following are planned for subsequent
phases and tracked separately:

* `LocalConstant` rows for `const` bindings — Phase 5.1 (deferred until the
  binder surfaces `BoundLocalConstant` with a compile-time value).
* Per-file `ImportScope` chains populated from `import` statements — Phase 5.2.
* `EmbeddedSource`, `SourceLink`, `CompilationOptions`,
  `CompilationMetadataReferences` — Phase 6.
* PE `DebugDirectory` entries (`CodeView`, `PdbChecksum`, `Reproducible`,
  `EmbeddedPortablePdb`) — Phase 7.

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
