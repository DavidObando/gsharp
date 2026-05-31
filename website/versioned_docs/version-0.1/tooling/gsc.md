---
title: "The gsc compiler"
sidebar_position: 1
draft: false
---

# The gsc compiler

`gsc` is the command-line compiler driver for G#. It accepts one or more `.gs` source files, parses and binds them with the shared compiler front end, and then either runs the program in-process or emits a managed .NET assembly.

## Basic usage

```bash
gsc Program.gs
```

With no `/out:<path>` option, `gsc` uses interpreter mode. The program is evaluated in the current process. If diagnostics contain errors, they are printed and the process exits with failure; otherwise `gsc` prints `Success.`.

```bash
gsc Program.gs /out:bin/Hello.dll
```

With `/out:<path>`, `gsc` uses emit mode. It writes the PE assembly to the requested path, prints `Wrote <path>`, and exits with success when emit diagnostics contain no errors. Executable outputs also get a sibling `.runtimeconfig.json`.

```bash
dotnet bin/Hello.dll
```

For executables, the runtime config defaults to `net10.0`. Passing `/targetframework:<tfm>` or `/tfm:<tfm>` changes the `tfm` and framework version for `net8.0`, `net9.0`, and `net10.0`; unknown TFMs currently fall back to the `Microsoft.NETCore.App` `10.0.0` framework entry.

## Source files, switches, and response files

Every non-switch argument is treated as a source file. `gsc` requires at least one source file and reports an error if any file does not exist.

Switches may begin with `/` or `-`. On Unix-like systems, absolute source paths such as `/Users/me/app/Program.gs` are treated as files, not switches, when they contain path separators. Unknown switches are ignored for SDK forward compatibility.

Response files are supported with `@file.rsp`. Each non-empty UTF-8 line becomes one argument; lines whose first non-space character is `#` are comments.

```text title="app.rsp"
# Compiler arguments
/out:bin/App.dll
/target:exe
/tfm:net10.0
Program.gs
```

```bash
gsc @app.rsp
```

## Command-line options

This is the complete option list accepted by `src/Compiler/Program.cs` argument parsing.

| Option | Accepted values and behavior |
| --- | --- |
| `/out:<path>` | Emit a PE assembly to `<path>`. Its presence selects emit mode; absence selects interpreter mode. |
| `/refout:<path>` | Emit a metadata-only reference assembly to `<path>` in the same compiler invocation. |
| `/assemblyname:<name>` | Override the emitted assembly name. |
| `/version:<string>` | Set the version string forwarded to emit metadata. |
| `/target:exe` | Emit an executable assembly. This is the default target. |
| `/target:library`, `/target:lib`, `/target:dll` | Emit a library assembly. No `.runtimeconfig.json` is written for library targets. |
| `/targetframework:<tfm>` | Set the target framework moniker. Used for executable runtime config and target-framework reference identity. |
| `/tfm:<tfm>` | Alias for `/targetframework:<tfm>`. |
| `/r:<path>` | Add a metadata or reference assembly. May be repeated. |
| `/reference:<path>` | Alias for `/r:<path>`. |
| `/implicitimports` | Enable the implicit `System` import. Bare switch means true. |
| `/implicitimports:true`, `/implicitimports:false` | Enable or disable implicit imports. Boolean values accepted by the parser are `true`, `false`, `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/implicit-imports` | Hyphenated alias for `/implicitimports`. Also accepts the same optional boolean value. |
| `/noimplicitimports` | Disable the implicit `System` import. |
| `/no-implicit-imports` | Hyphenated alias for `/noimplicitimports`. |
| `/nowarn:<ids>` | Suppress warning diagnostics with the listed comma-separated IDs. IDs may be canonical, such as `GS9100`, or numeric, such as `9100`; numeric forms normalize to `GS####`. |
| `/warnaserror` | Promote all warnings to errors. |
| `/warnaserror:<ids>` | Promote the listed warning IDs to errors. |
| `/warnaserror+:<ids>` | Alias for promoting the listed warning IDs to errors. |
| `/warnaserror-:<ids>` | Keep the listed IDs as warnings even when global `/warnaserror` is set. |
| `/debug` | Emit a sidecar Portable PDB. Equivalent to `/debug:portable`. |
| `/debug+` | Emit a sidecar Portable PDB. |
| `/debug-` | Disable debug information. |
| `/debug:none` | Disable debug information. |
| `/debug:portable` | Emit a sidecar Portable PDB. |
| `/debug:full` | Accepted as an alias for sidecar Portable PDB output. |
| `/debug:pdbonly` | Accepted as an alias for sidecar Portable PDB output. |
| `/debug:embedded` | Embed the Portable PDB in the PE. No sidecar PDB is written. |
| `/pdb:<path>` | Set the sidecar PDB output path. If no earlier debug option was seen, this implies `/debug:portable`. A path is required. |
| `/sourcelink:<path>` | Embed the specified Source Link JSON file as Portable PDB custom debug information. A path is required. |
| `/deterministic` | Enable deterministic MVID/PDB identity and the reproducible debug-directory marker. Bare switch means true. |
| `/deterministic:true`, `/deterministic:false` | Enable or disable deterministic emit. Also accepts `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/deterministic+` | Enable deterministic emit. |
| `/deterministic-` | Disable deterministic emit. |
| `/embed` | Embed every primary source file in the Portable PDB. Bare switch means true. |
| `/embed:true`, `/embed:false` | Enable or disable source embedding. Also accepts `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/embed+` | Enable source embedding. |
| `/embed-` | Disable source embedding. |
| `/?` | Parsed as a help switch, but current `gsc` does not display help before checking for source files. |
| `/help` | Parsed like `/?`, with the same current limitation. |

Unsupported values for `/target:<value>` and `/debug:<value>` are errors. Unsupported boolean values are errors.

## References and target frameworks

Use `/r:<path>` or `/reference:<path>` for every reference assembly the program needs. The SDK passes the full `ReferencePathWithRefAssemblies` closure so `MetadataLoadContext` can resolve transitive reference identities. If direct `gsc` use omits needed transitive references, `gsc` may report advisory warning `GS9100` naming missing assemblies.

```bash
gsc Program.gs /out:bin/App.dll /r:/path/to/System.Console.dll /tfm:net8.0
```

## Reference assemblies

`/refout:<path>` asks the emitter to write a metadata-only sibling assembly for package and cross-language consumption. The MSBuild SDK uses this for `ProduceReferenceAssembly=true` and places the result under the standard `ref/<tfm>/` package layout during `dotnet pack`.

```bash
gsc Library.gs /target:library /out:obj/MyLib.dll /refout:obj/refint/MyLib.dll
```

## Debug information

Sidecar Portable PDBs are selected with `/debug`, `/debug+`, `/debug:portable`, `/debug:full`, or `/debug:pdbonly`. If `/pdb:<path>` is omitted, the sidecar path defaults to the output path with a `.pdb` extension. Embedded PDBs are selected with `/debug:embedded`.

```bash
gsc Program.gs /out:bin/App.dll /debug:portable /pdb:bin/App.pdb /sourcelink:sourcelink.json /deterministic+
```

Use `/embed+` when you intentionally want all primary source bytes embedded in the PDB. This is useful for self-contained debugging artifacts but is opt-in because it ships source text inside symbols.

## Interpreter mode versus emit mode

Interpreter mode is useful for quick checks and compatibility with the REPL path. It shares parsing, binding, and lowering with the compiler but executes bound nodes in-process through `Evaluator`.

Emit mode is the production path for `dotnet build`, NuGet packaging, and debugging. It writes standard managed PE metadata through `ReflectionMetadataEmitter`; for executables it also writes `.runtimeconfig.json`, so the result can be launched with `dotnet`.
