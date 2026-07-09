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

This option list was checked against `dotnet out\bin\Release\Compiler\gsc.dll --help` for the 0.3 line.

| Option | Accepted values and behavior |
| --- | --- |
| `/out:<file>` | Emit a PE assembly to `<file>`. Its presence selects emit mode; absence selects interpreter mode. |
| `/refout:<file>` | Emit a metadata-only reference assembly to `<file>` in the same compiler invocation. |
| `/assemblyname:<name>` | Override the emitted assembly name. |
| `/version:<string>` | Set the informational version stamped on the output assembly. |
| `/target:exe` | Emit an executable assembly. This is the default target. |
| `/target:library`, `/target:lib`, `/target:dll` | Emit a library assembly. No `.runtimeconfig.json` is written for library targets. |
| `/targetframework:<tfm>` | Set the target framework moniker. Used for executable runtime config and target-framework reference identity. |
| `/tfm:<tfm>` | Alias for `/targetframework:<tfm>`. |
| `/r:<file>` | Add a metadata or reference assembly. May be repeated. |
| `/reference:<file>` | Alias for `/r:<file>`. |
| `/analyzer:<file>` | Add an already-resolved analyzer/source-generator assembly. Supplying at least one `/analyzer` makes `gsc` run `gsgen` before compiling and include generated `.g.gs` sources. May be repeated. |
| `/gsgentool:<file>` | Override the `gsgen.dll` path used by `/analyzer`; by default `gsc` looks for a sibling `gsgen.dll` in the packaged SDK layout. |
| `/additionalfile:<file>` | Forward a non-source generator input, such as an Avalonia `.axaml`, to `gsgen`. May be repeated. Meaningful when `/analyzer` is present. |
| `/globaloption:<key>=<value>` | Forward a project-wide analyzer-config option to `gsgen` as `build_property.<key>`. May be repeated. Meaningful when `/analyzer` is present. |
| `/lib:<path>` | Accepted for csc compatibility. Currently a no-op; pass full references with `/r:` or `/reference:`. |
| `/implicitimports` | Enable the implicit `System` import. |
| `/implicitimports:true`, `/implicitimports:false` | Enable or disable implicit imports. Boolean values accepted by the parser are `true`, `false`, `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/implicit-imports` | Hyphenated alias for `/implicitimports`. Also accepts the same optional boolean value. |
| `/noimplicitimports` | Disable the implicit `System` import. |
| `/no-implicit-imports` | Hyphenated alias for `/noimplicitimports`. |
| `/nowarn:<ids>` | Suppress warning diagnostics with the listed comma- or semicolon-separated IDs. IDs may be canonical, such as `GS9100`, or numeric, such as `9100`; numeric forms normalize to `GS####`. |
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
| `/pdb:<file>` | Set the sidecar PDB output path. If no earlier debug option was seen, this implies `/debug:portable`. |
| `/doc:<file>` | Emit XML documentation comments to the specified file. |
| `/sourcelink:<file>` | Embed the specified Source Link JSON file as Portable PDB custom debug information. |
| `/deterministic`, `/deterministic+` | Enable deterministic MVID/PDB identity and the reproducible debug-directory marker. |
| `/deterministic-` | Disable deterministic emit. |
| `/deterministic:true`, `/deterministic:false` | Enable or disable deterministic emit. Also accepts `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/embed`, `/embed+` | Embed every primary source file in the Portable PDB. |
| `/embed-` | Disable source embedding. |
| `/embed:true`, `/embed:false` | Enable or disable source embedding. Also accepts `1`, `0`, `on`, `off`, `yes`, and `no`. |
| `/log:<file>` | Write compiler diagnostic logging to the specified file. |
| `/?`, `/help`, `--help` | Show compiler help. |

Unsupported values for `/target:<value>`, `/debug:<value>`, and boolean switches are errors. Missing required values, such as `/doc` without a path or `/globaloption` without `key=value`, are also errors. Although the current help text shows `/implicitimports[+|-]`, the verified Release parser accepts `/implicitimports` and `/implicitimports:<bool>` but rejects `/implicitimports+` and `/implicitimports-`; use `/noimplicitimports` or `/implicitimports:false` to disable it.

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

XML documentation output is selected independently with `/doc:<file>` and is used by the SDK when `GenerateDocumentationFile` is enabled.

Use `/embed+` when you intentionally want all primary source bytes embedded in the PDB. This is useful for self-contained debugging artifacts but is opt-in because it ships source text inside symbols.

## Interpreter mode versus emit mode

Interpreter mode is useful for quick checks and compatibility with the REPL path. It shares parsing, binding, and lowering with the compiler but executes bound nodes in-process through `Evaluator`.

Emit mode is the production path for `dotnet build`, NuGet packaging, and debugging. It writes standard managed PE metadata through `ReflectionMetadataEmitter`; for executables it also writes `.runtimeconfig.json`, so the result can be launched with `dotnet`. If `/analyzer` is supplied, the driver first runs the sibling `gsgen` tool and adds its generated `.g.gs` files to the same compilation.
