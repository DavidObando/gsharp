---
title: "The gsc compiler"
sidebar_position: 1
draft: false
description: "Compile and run G# directly with gsc, including references, target frameworks, and output options."
---

# The gsc compiler

`gsc` is the command-line compiler driver for G#. It accepts one or more `.gs` source files, parses and binds them with the shared compiler front end, emits the program, and either runs it immediately or saves a managed .NET assembly.

## Basic usage

```bash
gsc Program.gs
```

With no `/out:<path>` option, `gsc` runs the emitted program immediately. If diagnostics contain errors, they are printed and the process exits with failure; otherwise `gsc` prints `Success.`.

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

| Option | Accepted values and behavior |
| --- | --- |
| `/out:<file>` | Save the emitted PE assembly to `<file>`. Without this option, `gsc` runs the emitted program immediately. |
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
| `/nullability:platform-types` | Default: import annotated references as `T` / `T?`, and oblivious references as platform types displayed as `T!`. The display notation is not source syntax. |
| `/nullability:enabled`, `/nullability:oblivious` | `enabled` reads oblivious imports as nullable (legacy). `oblivious` reads imports as platform types and marks this compilation's own declarations oblivious. Prefer the default for new projects. |
| `/nowarn:<ids>` | Suppress warning diagnostics with the listed comma- or semicolon-separated IDs. IDs may be canonical, such as `GS9100`, or numeric, such as `9100`; numeric forms normalize to `GS####`. |
| `/warnaserror` | Promote all warnings to errors. |
| `/warnaserror-` | Disable global warning promotion. The last global enable or disable option wins; selected-ID settings remain unchanged. |
| `/warnaserror:<ids>` | Promote the listed warning IDs to errors. |
| `/warnaserror+:<ids>` | Alias for promoting the listed warning IDs to errors. |
| `/warnaserror-:<ids>` | Keep the listed IDs as warnings even when global `/warnaserror` is set. |
| `/optimize`, `/optimize+` | Enable JIT optimization for emitted assemblies. This is the default. |
| `/optimize-` | Disable JIT optimization for emitted assemblies. |
| `/optimize:true`, `/optimize:false` | Enable or disable JIT optimization. Also accepts `1`, `0`, `on`, `off`, `yes`, and `no`. |
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
| `--workers:<1..32>` | Opt into bounded file parsing and independent primitive/local body binding. Defaults to 1. The SDK passes the actual MSBuild grant, not a second pool. |
| `--worker-memory-mib:<MiB>` | Concurrent workspace estimate budget; minimum 256, default 1024. Larger inputs reduce concurrency. This is not a total process memory limit. |
| `/?`, `/help`, `--help` | Show compiler help. |

Unsupported values for `/target:<value>`, `/debug:<value>`, and boolean switches are errors. Missing required values, such as `/doc` without a path or `/globaloption` without `key=value`, are also errors. Although the help text shows `/implicitimports[+|-]`, the parser accepts `/implicitimports` and `/implicitimports:<bool>` but rejects `/implicitimports+` and `/implicitimports-`; use `/noimplicitimports` or `/implicitimports:false` to disable it.

## References and target frameworks

Use `/r:<path>` or `/reference:<path>` for every reference assembly the program needs. The SDK passes the full `ReferencePathWithRefAssemblies` closure so `MetadataLoadContext` can resolve transitive reference identities. If direct `gsc` use omits needed transitive references, `gsc` may report advisory warning `GS9100` naming missing assemblies.

`GS9100` uses the same severity and suppression options as other diagnostics. Global or selected `/warnaserror` promotion returns a nonzero exit code before emission. `/nowarn:GS9100` suppresses the warning before warning promotion.

An assembly mentioned only by a facade's type forwarders is not an eager reference-closure dependency. Missing optional forwarded surfaces do not produce `GS9100`. A reference that also uses that assembly in its type metadata still requires it. Using an unavailable forwarded type produces the ordinary binding error rather than silently accepting the missing type.

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

## Immediate execution versus saved output

Both `gsc` modes use the emitter. Without `/out`, `gsc` runs the result immediately; with `/out`, it saves standard managed PE metadata and, for executables, a `.runtimeconfig.json` that can be launched with `dotnet`. If `/analyzer` is supplied, the driver first runs the sibling `gsgen` tool and adds its generated `.g.gs` files to the same compilation.

## Opt-in phase measurements

Set `GSHARP_MEASURE_PHASES` to a JSON output path to measure a compilation without changing normal stdout or diagnostics:

```bash
mkdir -p measurements
GSHARP_MEASURE_PHASES='measurements/gsc-{pid}-{id}.json' gsc @Library.rsp
```

The parent directory must exist. `{pid}` expands to the process ID; `{id}` expands to a new request ID. Use both tokens for multi-project builds or reusable processes. A fixed path is overwritten by each request. An unwritable measurement path is an I/O error, not silent success.

Schema version 1 records tool/runtime versions, compilation options, source bytes/files, reference/method counts, worker grants, cache counters, and named spans. Spans cover parsing, reference setup and lazy indexes, declarations, bodies and whole-program analyses, lowering passes, implementation/reference emit, PDB serialization, documentation, and analyzers when those stages run. Cached or unused stages do not produce synthetic spans.

Each span has an ID, parent ID, process-relative start time, elapsed time, process CPU/allocation deltas, current working set, process-lifetime peak working set, and managed heap size. CPU and allocation counters include all process activity, including runtime work. Nested and overlapping spans are **not additive**: the body span already includes its whole-program analysis, and implementation emit includes PDB serialization. Use the root compilation span for overall elapsed time. Process-lifetime peak memory is not a per-request peak.

`StartMilliseconds` and `RequestStartMilliseconds` share a monotonic origin across requests in the same process. The origin is initialized when the measurement facility is first used, not at OS process creation. `TimestampFrequency` records the monotonic timer's ticks per second.

API hosts can use `CompilationMeasurements.Start(tool)` with `BeginPhase(name)`, `Count(name, amount)`, and `SetProperty(name, value)`, then `WriteJson(path)`. An explicit host session owns nested driver instrumentation, even when the environment variable is set. Dispose all phases before disposing the request. Disabled measurement calls do not allocate phase objects. Measurements do not enable parallel workers or alter compiler semantics.
