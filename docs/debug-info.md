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



The Portable PDB writer is shipped. The current implementation emits
`Document`, `MethodDebugInformation`, `LocalScope`, `LocalVariable`, a single
root `ImportScope`, `CustomDebugInformation` rows for `EmbeddedSource` /
`SourceLink` / `CompilationOptions`, and PE-side `DebugDirectory` entries
(`CodeView`, `PdbChecksum`, `Reproducible`, `EmbeddedPortablePdb`). The
policy decisions behind those choices are recorded in
[ADR-0048](adr/0048-portable-pdb-emit.md); the pipeline diagram and
component list live in [`emit-pipeline.md`](emit-pipeline.md). The
following extensions are tracked separately:

* `LocalConstant` rows for `const` bindings — deferred until the binder
  surfaces `BoundLocalConstant` with a compile-time value (#216).
* Per-file `ImportScope` chains populated from `import` statements (#217).
* `CompilationMetadataReferences` rows (#219).

## Custom debug information (Phase 6)

GSharp emits the following `CustomDebugInformation` kinds:

| Kind | Kind GUID | Parent | When emitted |
| --- | --- | --- | --- |
| `EmbeddedSource` | `0E8A571B-6926-466E-B4AD-8AB04611F5FE` | `Document` row | `/embed[+/-]` / `EmbedAllSources=true` |
| `SourceLink` | `CC110556-A091-4D38-9FEC-25AB9A351A6A` | `Module` row | `/sourcelink:<file>` supplied and file exists |
| `CompilationOptions` | `B5FEEC05-8CD0-4A83-96DA-466284BB4BD8` | `Module` row | Always (cheap; ~80 bytes) |

### `EmbeddedSource` blob layout

```
formatMarker : int32 (little-endian)
bytes        : remainder of blob
```

`formatMarker == 0` ⇒ the bytes are the raw UTF-8 source. `formatMarker > 0`
⇒ the bytes are `Deflate`-compressed and `formatMarker` is the uncompressed
size. Phase 6 always writes uncompressed (`formatMarker = 0`); deflate
compression is a future size optimisation that does not require a reader
change.

### `SourceLink` blob layout

The raw bytes of the Source-Link JSON file as passed to `/sourcelink:<file>`,
unmodified. The PDB spec does not transform or re-encode the payload.

### `CompilationOptions` blob layout

A sequence of `(utf8 name \0 utf8 value \0)` pairs. The Phase 6 set is:

| Name | Value |
| --- | --- |
| `compiler-name` | `gsc` |
| `compiler-version` | `Assembly.GetExecutingAssembly().GetName().Version` of `GSharp.Core` |
| `language` | `GSharp` |
| `language-version` | `1.0` (placeholder until a language-version concept lands) |

## PE-side debug directory (Phase 7)

When `/debug` is on, the emitter populates the PE's `IMAGE_DIRECTORY_ENTRY_DEBUG`
table via `DebugDirectoryBuilder`:

| Entry | When | Payload |
| --- | --- | --- |
| `CodeView` | Always (sidecar + embedded) | PDB content id (GUID + age = 1) and the PDB file name. For sidecar emit this is the value of `/pdb:<path>` if supplied, else `<AssemblyName>.pdb`. For embedded emit it is also the conventional bare name (debuggers ignore the path field for embedded PDBs). |
| `PdbChecksum` | Always | Algorithm `SHA256` plus the 32-uint8 SHA-256 digest of the serialized Portable PDB blob — same bytes a sidecar `.pdb` would contain. Symbol servers verify PE↔PDB pairing by this checksum. |
| `Reproducible` | When `/deterministic` is set | Empty payload; marker bit. |
| `EmbeddedPortablePdb` | When `/debug:embedded` | Deflate-compressed copy of the Portable PDB blob inlined into the PE. No sidecar is written even if a stream is supplied. |

The PDB content id is shared between the in-PE `CodeView.Guid` and the
Portable PDB metadata header's `Id` field, so a debugger that locates a
candidate sidecar can verify the pairing without reading the full PE.

## Compiler flags

The `gsc` compiler accepts the standard Roslyn-style debug flags:

| Flag | Meaning |
| --- | --- |
| `/debug[+/-]` | Equivalent to `/debug:portable` / `/debug:none`. |
| `/debug:none` | Suppress all debug information. |
| `/debug:portable` (alias `/debug:pdbonly`, `/debug:full`) | Emit a sidecar `*.pdb` next to the PE. |
| `/debug:embedded` | Embed the Portable PDB inside the PE's debug directory. |
| `/pdb:<path>` | Override the sidecar PDB output path. |
| `/sourcelink:<file>` | Embed the supplied Source-Link JSON as `CustomDebugInformation`. |
| `/embed[+/-]` | Embed every primary source file as an `EmbeddedSource` row (recommended with `/debug:embedded`). |
| `/deterministic[+/-]` | Emit a content-hash-based Mvid / PdbId. |

The SDK forwards `<DebugType>` and `<PdbFile>` through `BuildTask` so MSBuild-driven builds behave identically to direct `gsc` invocations.

## SDK / MSBuild properties

`Gsharp.NET.Sdk` exposes the standard .NET debug properties and threads them
through `BuildTask` into the matching `gsc` flag. The property names match
the C# / F# SDKs, so an enterprise consumer can apply the same `Directory.Build.props`
to a mixed-language solution and have GSharp projects honour the same
conventions.

| Property | Default | Forwarded as | Effect |
| --- | --- | --- | --- |
| `<DebugType>` | `portable` in `Debug`, `none` in `Release` | `/debug:<value>` | Selects no PDB / sidecar Portable PDB / embedded Portable PDB. |
| `<DebugSymbols>` | derived from `<DebugType>` | (gates whether the build writes a sidecar PDB) | When `true` and `<DebugType>` is `portable`/`pdbonly`/`full`, the SDK adds `obj/.../<Asm>.pdb` to `@(FileWrites)` and the standard `CopyFilesToOutputDirectory` target copies it next to the produced `*.dll`. |
| `<PdbFile>` | `obj/.../<AssemblyName>.pdb` | `/pdb:<path>` | Override the sidecar output path. |
| `<EmbedAllSources>` | `false` | `/embed+` | Embed every primary source file in the PDB as `EmbeddedSource` rows. Recommended when `<DebugType>embedded</DebugType>` is on so debugging the assembly never depends on the local source tree. |
| `<SourceLink>` | (none) | `/sourcelink:<file>` | Embed the supplied Source-Link JSON as a `CustomDebugInformation` row. |
| `<Deterministic>` | `true` for the official build, `false` otherwise | `/deterministic+/-` | Switch the Mvid / PdbId to a content hash and emit the `Reproducible` debug-directory entry. |

`Gsharp.NET.Sdk` does *not* invent any of these property names — they are the
same surface every modern .NET SDK consumes, so existing CI snippets that set
`<DebugType>embedded</DebugType>`, `<EmbedAllSources>true</EmbedAllSources>`, or
`<Deterministic>true</Deterministic>` "just work" against a GSharp project.

## Acceptance tests (Phase 9)

The end-to-end debug-info contract is verified at two levels:

* **`test/Compiler.Tests/Acceptance/StackTraceTests.cs`** — compiles a
  small `.gs` source through `gsc` with `/debug:portable /pdb:...`, loads
  the PE + sidecar PDB into an `AssemblyLoadContext` via
  `LoadFromStream(peStream, pdbStream)`, invokes a method that throws, and
  asserts that `Exception.StackTrace` cites the original `.gs` file at the
  throwing line. Variants cover a synchronous throw, a throw inside a
  `for var x = 0; x < n; x++` body (validating that lowering preserves
  user-visible sequence points), a throw across a non-trivial call
  boundary, and a throw after `await` in an `async` function (validating
  that Phase 5's async state-machine PDB rows resume on the correct line).
* **`build/debugger-e2e.sh`** — a smoke test that packs the SDK, builds a
  GSharp library, builds a C# console host that calls the library via
  reflection, then drives [`netcoredbg`](https://github.com/Samsung/netcoredbg)
  in MI mode. It sets a breakpoint by `<.gs-file>:<line>`, runs to the
  break, lists locals, continues, and asserts the program exits with the
  expected result. The script skips cleanly when `netcoredbg` is not
  installed for the host's `(os, arch)` pair (in particular, upstream
  does not yet ship `osx-arm64`), so it is safe to invoke in any CI lane.
