---
title: "Compiler architecture"
sidebar_position: 6
draft: false
---

# Compiler architecture

G# has a shared front end and two execution backends: an interpreter used by no-output `gsc` runs and the REPL, and an emit pipeline used by `dotnet build`, libraries, packages, and debugging.

## End-to-end pipeline

```text
.gs source → Lexer → Parser → Syntax tree → Binder → BoundProgram → Lowerer → Backend
```

The front end lives under `src/Core/CodeAnalysis`. The lexer and parser produce syntax trees, the binder resolves names and types into symbols and bound nodes, and lowering rewrites higher-level constructs into forms that the backends can execute or emit.

## Emit backend

The production compiler path writes managed PE metadata directly with `ReflectionMetadataEmitter` and `System.Reflection.Metadata.Ecma335`.

```text
BoundProgram (lowered) → ReflectionMetadataEmitter → PE assembly
                                      │
                                      └→ PortablePdbEmitter → sidecar or embedded PDB
```

`gsc` owns command-line parsing, response-file expansion, output stream creation, optional reference-assembly output, Portable PDB stream selection, and `.runtimeconfig.json` generation for executable outputs. `Gsharp.NET.Sdk` wraps the same driver from MSBuild by building a response file and invoking `dotnet gsc.dll` during `CoreCompile`.

## No Roslyn dependency in the emit path

ADR-0027 accepted the v1.0 decision to stay on the bespoke emitter. G# does not use Roslyn to write assemblies at runtime. The motivation is practical: NuGet-distributable assemblies and cross-language debugging require standard ECMA-335 metadata and Portable PDBs, and those are available directly through `System.Reflection.Metadata`. Roslyn analyzer/workspace/source-generator interop remains a possible future trigger, but it is not part of the current emit path.

## Interpreter backend

When `gsc` is called without `/out:<path>`, it evaluates the program in-process. The interpreter shares the same syntax, binding, and lowering stages, then walks bound nodes with `Evaluator` instead of emitting IL. This path is also used by the REPL and many language tests. It is useful for quick execution and semantic validation, while emitted assemblies are the production path.

## Lowering and generated code

Lowering prepares language constructs for execution and emit. Examples include top-level entry-point synthesis, `defer` and cleanup lowering, `for in` patterns, async state machines, and sync/async iterator state machines. Async and iterator lowering synthesize state-machine types and hidden scaffolding while preserving source sequence points for debugging.

Top-level statements are lowered to a synthesized entry point unless an explicit `func Main()` takes precedence. Mixing explicit and synthesized entry points is diagnosed.

## Packages, namespaces, and assemblies

G# `package` declarations map to CLR namespaces. ADR-0028 selected a .NET-style multi-package-per-project model: one `.gsproj` produces one assembly, and that assembly may contain multiple packages/namespaces. The assembly name comes from project metadata such as `AssemblyName`, `RootNamespace`, or the project file name, not from whichever source file the compiler sees first.

The emitter produces separate namespace/type metadata for each package. The package containing top-level statements owns the synthesized entry point for executable assemblies.

## References and target frameworks

`gsc` can run on .NET 10 while emitting for other target frameworks. The compiler routes user and SDK references through `ReferenceResolver` and an isolated metadata load context. User-supplied target-framework reference assemblies shadow the compiler host assemblies, so emitted type references carry the target framework's identity.

This is why SDK builds pass the complete reference assembly closure through `/r:<path>` arguments and why direct `gsc` usage should do the same for non-trivial projects.

## Portable PDBs

When debug information is enabled, `ReflectionMetadataEmitter` collaborates with `PortablePdbEmitter`. The PDB records document rows, SHA-256 hashes of raw source bytes, sequence points, local scopes, local variables, embedded source, Source Link, compilation options, and PE debug-directory data. ADR-0048 records the PDB policy decisions.

## Type-erased generics model

G# supports generic syntax and binding, but the implementation model is intentionally CLR-oriented. Generic type parameters are represented in symbols and metadata, constraints are bound by name, and emitted assemblies rely on the CLR's runtime generic representation rather than C++-style monomorphization. At runtime, generic type arguments are not duplicated into separate method or type bodies per closed instantiation.

This keeps the language aligned with .NET interop: G# generic types and methods can be represented in managed metadata and consumed by other CLR languages.

## Contributor file map

| Area | Representative paths |
| --- | --- |
| CLI driver | `src/Compiler/Program.cs` |
| Lexer/parser/syntax | `src/Core/CodeAnalysis/Syntax/` |
| Binding and symbols | `src/Core/CodeAnalysis/Binding/`, `src/Core/CodeAnalysis/Symbols/` |
| Lowering | `src/Core/CodeAnalysis/Lowering/` |
| Interpreter | `src/Core/CodeAnalysis/Evaluator.cs`, `src/Interpreter/` |
| PE emit | `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` |
| Portable PDB emit | `src/Core/CodeAnalysis/Emit/PortablePdbEmitter.cs` |
| SDK integration | `src/Sdk/Gsharp.NET.Sdk/` |
| Language server | `src/LanguageServer/` |
