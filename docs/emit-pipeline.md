# Emit pipeline

GSharp has two execution backends. The interpreter (`Evaluator`) walks the bound tree in-process and is what powers the REPL and most language tests. The emit pipeline produces standalone managed PEs that load and run under any compatible .NET runtime. This document describes the emit pipeline only; the interpreter remains the canonical reference for language semantics, but compiling to disk is now the production path for `dotnet build`.

```
.gs source ──► Lexer ──► Parser ──► Syntax tree
                                       │
                                       ▼
                                     Binder ──► BoundProgram
                                       │
                                       ▼
                                    Lowerer ──► BoundProgram (lowered)
                                       │
                                       ▼
                          ReflectionMetadataEmitter ──► PE stream
                                       │
                                       ▼
                          gsc.dll writes <name>.dll + .runtimeconfig.json
                                       │
                                       ▼
                          MSBuild (via Gsharp.NET.Sdk) wraps the whole thing
```

## Components

| Layer | Type | Responsibility |
| --- | --- | --- |
| Syntax | `GSharp.Core.CodeAnalysis.Syntax.*` | Tokenization + parsing into a tree of `SyntaxNode`s. |
| Binding | `Binder`, `BoundScope`, `BoundProgram` | Resolve names, type-check, lower, synthesize a top-level entry-point method (C# 9-style). |
| Emit | `ReflectionMetadataEmitter` | Walk the lowered `BoundProgram` and write a PE using `System.Reflection.Metadata.Ecma335` directly — no Roslyn dependency at runtime. |
| Compiler driver | `gsc` (`src/Compiler`) | Parse command-line args (`/out`, `/r`, `/target`, `/targetframework`, response files), produce the PE, and write `<name>.runtimeconfig.json` for executable outputs. |
| MSBuild SDK | `Gsharp.NET.Sdk` | Wire `CoreCompile` into `Microsoft.NET.Sdk` so `.gsproj` files participate in the standard build pipeline. The SDK's task DLL is `netstandard2.0`; the compiler payload is `net10.0` invoked as `dotnet gsc.dll`. |

## Entry-point synthesis

GSharp supports C# 9-style top-level statements. The binder lowers a file's top-level statements into a single hidden `MethodSymbol` (logically `<TopLevel>$.<Main>$(string[] args)`). The emitter marks that method as the assembly entry point. An explicit `func Main()` is supported and takes precedence; mixing both in the same compilation is an error. See [`Gsharp-design-v0.1.md`](../design/Gsharp-design-v0.1.md) for the language-level contract.

## Cross-TFM emit

The emitter is hosted in `gsc.dll`, which itself targets `net10.0`. Without special care, every emitted assembly would reference `System.Private.CoreLib, Version=10.0.0.0` regardless of the requested `TargetFramework`, and any non-net10.0 output would fail to load with `FileNotFoundException`.

To produce assemblies that match the requested TFM, the compiler routes reference assemblies through `ReferenceResolver`:

- `ReferenceResolver.WithReferences(paths)` loads the user-supplied reference assemblies into an isolated `System.Reflection.MetadataLoadContext`. The gsc host's trusted-platform-assembly list is appended as a *fallback* — user paths come first in the `PathAssemblyResolver`, so target-ref-pack BCL assemblies (`System.Runtime.dll`, `System.Console.dll`, etc.) shadow the host copies.
- `Type` instances handed back from the resolver carry the target framework's assembly identities (e.g. `System.Console, Version=8.0.0.0` for a `net8.0` build).
- `ReferenceResolver.GetCoreType("System.Object")` / `"System.String"` is the entry-point the emitter uses to seed primitive type references, rather than calling `typeof(object)` / `typeof(string)` which would bind to the gsc host's `System.Private.CoreLib`.
- `ClrTypeUtilities.AreSame` and `ClrTypeUtilities.IsAssignableByName` compare `Type`s by `FullName` so the binder and emitter work even when types come from different reflection contexts. Reference-equality (`==`) and `Type.IsAssignableFrom` only work within a single context.

The end-to-end correctness of this pipeline is gated by [`build/multitarget-e2e.sh`](../build/multitarget-e2e.sh), which builds and runs the HelloWorld sample for every TFM in `TARGET_FRAMEWORKS` and asserts the expected stdout.

## Where Roslyn fits in

The emit path does **not** depend on Roslyn — `ReflectionMetadataEmitter` writes PE bytes directly via `System.Reflection.Metadata`, and v1.0 ships on this path. [ADR-0027](adr/0027-roslyn-fork-decision.md) records the decision to close the Roslyn-fork track (issue #51) as `wontfix` for v1.0; NuGet-distributable libraries and full cross-language debugger support (Portable PDB, Source Link, embedded sources) are delivered by extending the bespoke emitter rather than by adopting Roslyn. The vendored tree under [`src/Roslyn`](../src/Roslyn) remains in the repo as inactive reference material and is excluded from `GSharp.sln`; revival is possible if any of the four triggers in issue #51 (analyzer `ISymbol` interop, shared Roslyn workspaces, in-GSharp source generators, shared metadata-import at scale) materialises post-v1.0.

## Interpreter vs. emit

The in-process `Evaluator` remains the canonical reference for language semantics and is still the default execution backend for the REPL and most language tests. The emit pipeline mirrors its lowering behavior for any construct it supports; if the two ever disagree, the interpreter is treated as authoritative. Both paths share the `Binder`, `BoundProgram`, and lowering stages — only the final code-generation step differs.

## File map

| Path | What lives there |
| --- | --- |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | PE emitter. |
| `src/Core/CodeAnalysis/Symbols/ReferenceResolver.cs` | Reference-assembly loading + core-type lookup. |
| `src/Core/CodeAnalysis/Symbols/ClrTypeUtilities.cs` | Cross-context `Type` comparison helpers. |
| `src/Core/CodeAnalysis/Compilation/Compilation.cs` | Threads the resolver from `Compilation` through to the emitter. |
| `src/Compiler/Program.cs` | `gsc` command-line driver, response-file expansion, runtimeconfig.json generation. |
| `src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets` | MSBuild `CoreCompile` override that invokes `gsc.dll` via the SDK's build task. |
| `src/Sdk/Gsharp.NET.Sdk/BuildTask.cs` | MSBuild task that materializes a response file and shells out to `dotnet gsc.dll`. |
