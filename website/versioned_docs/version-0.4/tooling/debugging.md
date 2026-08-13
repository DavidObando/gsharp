---
title: "Debugging and PDBs"
sidebar_position: 5
draft: false
---

# Debugging and PDBs

G# emits standard managed .NET assemblies and standards-conformant Portable PDB symbols. That means existing .NET debuggers such as Visual Studio, `vsdbg`, `netcoredbg`, JetBrains Rider, and diagnostic tools can map IL offsets back to `.gs` source files without a G#-specific debug adapter.

## What is supported

Portable PDB emission records:

- the stable G# language GUID `4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00` on every document row;
- SHA-256 document hashes;
- method sequence points for user-visible statements, with synthesized scaffolding hidden;
- local scopes and local variable rows, with compiler-generated locals hidden from debugger locals views;
- embedded source, Source Link, compilation options, and PE debug-directory entries when requested.

G# implements this directly on the bespoke `System.Reflection.Metadata` emitter rather than by adopting Roslyn.

## Compiler flags

Use `gsc` debug flags directly or set the matching MSBuild properties in a `.gsproj`.

| `gsc` flag | Effect |
| --- | --- |
| `/debug`, `/debug+`, `/debug:portable` | Emit a sidecar Portable PDB. |
| `/debug:full`, `/debug:pdbonly` | Accepted aliases for sidecar Portable PDB output. |
| `/debug:embedded` | Embed the Portable PDB in the PE. |
| `/debug-`, `/debug:none` | Disable debug information. |
| `/pdb:<path>` | Override sidecar PDB path; implies portable debug if no debug flag appeared earlier. |
| `/sourcelink:<file>` | Embed Source Link JSON. |
| `/embed`, `/embed+` | Embed primary source files in the PDB. |
| `/embed-` | Disable source embedding. |
| `/deterministic`, `/deterministic+` | Emit deterministic MVID/PDB IDs and the reproducible debug-directory marker. |
| `/deterministic-` | Disable deterministic emit. |

```bash
gsc Program.gs /out:bin/App.dll /debug:portable /pdb:bin/App.pdb
```

## MSBuild properties

The SDK maps standard .NET debug properties to the same compiler flags.

```xml title="MyApp.gsproj"
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <DebugType>portable</DebugType>
    <Deterministic>true</Deterministic>
  </PropertyGroup>
</Project>
```

Use `<DebugType>embedded</DebugType>` and `<EmbedAllSources>true</EmbedAllSources>` only when you deliberately want a self-contained debug artifact. Embedding source is off by default because it places raw source bytes in the symbol data.

## Source matching requirements

Debuggers bind breakpoints by matching PDB document names and hashes to files on disk. The compiler therefore loads source files through absolute paths before building syntax trees, so Portable PDB document names are rooted. A relative document name can cause `vsdbg` and CoreCLR debugging to open a phantom tab instead of the source file.

The document hash is SHA-256 over the raw on-disk file bytes, including any byte-order mark. The compiler uses the `SourceText.RawBytes` when available rather than re-encoding decoded text, because re-encoding would drop a BOM and produce a hash that debuggers reject.

## Sequence points

The emitter anchors visible sequence points at the first IL offset for each lowered `BoundStatement`. User statements such as declarations, expression statements, returns, branches, loop bodies, `defer` blocks, async code, and iterator bodies get visible mappings. Synthesized state-machine dispatch, iterator handshakes, and other compiler scaffolding are hidden so stepping behaves like source-level G# rather than emitted IL.

## Debugging in VS Code

1. Create or open a `.gsproj` project.
2. Build with debug information enabled. `Debug` builds default to portable symbols through the SDK; set `<DebugType>portable</DebugType>` explicitly if needed.
3. Install the VS Code G# extension and the .NET runtime/debugger support required by your environment.
4. Add or generate a launch configuration that points at the built `.dll`.
5. Set breakpoints in `.gs` files and start debugging.

```json title=".vscode/launch.json"
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch G# app",
      "type": "coreclr",
      "request": "launch",
      "preLaunchTask": "dotnet: build",
      "program": "${workspaceFolder}/bin/Debug/net10.0/MyApp.dll",
      "args": [],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "stopAtEntry": false
    }
  ]
}
```

If breakpoints do not bind, verify that the `.pdb` is next to the built assembly, the source file path in the PDB is absolute and points to your checked-out file, and the file bytes have not changed since the build.
