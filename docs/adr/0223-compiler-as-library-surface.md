# ADR-0223: A supported compiler-as-library surface for GSharp.Core

- **Status**: Accepted (approved by the maintainer, 2026-11-17)
- **Date**: 2026-11-16
- **Phase**: Tooling
- **Related**: ADR-0207 (bundled runtime discovery), ADR-0212 §8 (concurrent declaration binding), issue #3818 (host load contexts), issue #5623 (GS0634), Oats `docs/notes/gsharp-compiler-as-library.md`

## Context

Hosts other than `gsc` use `GSharp.Core` directly. The language server and the REPL are in this repository. The Oats project is an external host: it checks generated G# source, reports structured diagnostics, and runs the program in a child process.

Oats found that every API it calls is public, but the contract around those APIs is not defined:

1. `GSharp.Core` is not a package. A host references `tools/compiler/GSharp.Core.dll` in the `Gsharp.NET.Sdk` package through `$(GsharpSdkToolsDirectory)`. Neither the folder layout nor the property is a documented contract. The host also references the compiler's dependencies (`System.Reflection.MetadataLoadContext`, `Microsoft.VisualStudio.Validation`) by hand.
2. Some diagnostics that `gsc` reports are not reachable from public APIs. `Compilation.GetMissingEntryPointDiagnostics()` (GS0634) and `Compilation.CreateInternalErrorDiagnostic(Exception)` (GS9998) are `internal`.
3. `ReferenceResolver.Default()` and `ReferenceResolver.WithRuntimeReferences(paths)` build the reference set from the assemblies that the host process has loaded. A checked program can therefore see different types in a test host, a benchmark host, and `gsc`.
4. Bundled runtime discovery (ADR-0207) uses `ReferenceResolver.SdkToolsDirectory`, which is `internal`, or the `GSHARP_SDK_TOOLS_DIR` environment variable. A library host can only set a process-wide environment variable.
5. No document states which objects a host can use from more than one thread.

## Decision

### D1. Entry-point and internal-error diagnostics are public (implemented)

`Compilation.GetMissingEntryPointDiagnostics()` and `Compilation.CreateInternalErrorDiagnostic(Exception)` become `public`. Their behavior does not change.

- `GetMissingEntryPointDiagnostics()` returns GS0634 when the compilation is not a library, has no entry point, and is not a REPL submission. The host decides that the output is an executable, as `gsc` does with `/target:exe`. The host calls it only when no other error stops the output.
- `CreateInternalErrorDiagnostic(Exception)` converts an exception that escapes the compiler into a diagnostic. It preserves an explicit diagnostic ID from an `EmitDiagnosticException` in the exception chain; otherwise, it returns GS9998. It uses an available `EmitDiagnosticException` source anchor. A host can report the returned diagnostic as `gsc` does.

These are the only changes to code in this ADR.

### D2. Packaging (implemented, #6067)

Publish `GSharp.Core` as its own NuGet package, `Gsharp.Compiler`, from the same build as `Gsharp.NET.Sdk`, with the same version.

- The package contains `lib/net10.0/GSharp.Core.dll` and its XML documentation.
- The nuspec lists the compiler's dependencies (`System.Reflection.MetadataLoadContext`, `Microsoft.VisualStudio.Validation`, and others) as package dependencies, so a host does not reference them by hand.
- The package contains the G# runtime assemblies (`Gsharp.Extensions`, `Gsharp.Runtime.Channels`, `Gsharp.Runtime.Values`) under `runtimes/gsharp/`. These are the same binaries that the SDK places in `tools/`. The SDK must ship one `Gsharp.Extensions.dll`, not a different copy in `tools/compiler/` and `tools/extensions/`.
- The public API snapshot (`test/Core.Tests/Baselines/gsharp-core-public-api.txt`) becomes the compatibility record for the package. Pre-1.0 releases can break it, but each break gets a release note.

Until the package exists, `$(GsharpSdkToolsDirectory)compiler/GSharp.Core.dll` is the documented reference path. The SDK keeps the property name and that relative path for the 0.5 line.

Implementation notes:

- `src/Sdk/Gsharp.Compiler/Gsharp.Compiler.gsproj` packs the build output of `src/Core`. It packs `GSharp.Core.pdb` beside the DLL in `lib/net10.0/`, so the package has no symbol package.
- The package dependencies come from the `PackageReference` items of the pack project. `build/gsharp.build.props` defines the `System.Reflection.MetadataLoadContext` version once for `src/Core` and the pack project.
- `runtimes/gsharp/` is a flat folder. NuGet does not select files from it, so a host does not reference them. A host gives the folder to the compiler as the bundled runtime directory (D4).
- The SDK's `tools/compiler/`, `tools/gsgen/`, and `tools/formatter/` folders packed the bootstrap SDK's `Gsharp.Extensions.dll` and `Gsharp.Runtime.Channels.dll`. They now pack the files of the same build, as ADR-0210 does for `Gsharp.Runtime.Values.dll`.
- `build/release-publish.py verify` checks that the SDK has one copy of each runtime assembly, and that `Gsharp.Compiler` has the same bytes, `GSharp.Core`, and the `System.Reflection.MetadataLoadContext` dependency.

### D3. Hermetic reference sets (design only)

Add explicit factories to `ReferenceResolver`:

- `ForReferencePack(targetFramework, packRoot?)` finds `Microsoft.NETCore.App.Ref/<version>/ref/<tfm>` under the .NET SDK root (`DOTNET_ROOT` or the `dotnet` on the path) and adds the bundled G# runtimes. The result does not depend on the assemblies that the host has loaded. `RefactoringBaselineTests` already builds this set by hand (#4665), so the factory moves that logic into `GSharp.Core`.
- `WithReferences(paths)` stays the explicit form.
- `WithRuntimeReferences(paths)` and `Default()` keep their behavior. Their documentation states that the result depends on the host process.
- `CaptureHostAssemblies()` and the two-argument `WithRuntimeReferences` become public, so a host can capture the host snapshot once before work starts, as `gsc` does.

### D4. Bundled runtime directory (design only)

Replace the `internal` static `SdkToolsDirectory` with an explicit option. `ReferenceResolver` factories take an optional `runtimeDirectory` argument, and `ResolveDriverReferencePaths` takes the same argument. The search order is: the argument, then the folder beside the application, then `GSHARP_SDK_TOOLS_DIR`. A process-wide setter is not added, because two hosts in one process can need different SDK versions.

### D5. Thread-safety contract (documentation now, stress test before "supported")

These statements describe the current code:

- One `Compilation` can be queried from more than one thread. `GetDiagnostics`, `GetDeclarationDiagnostics`, `GetBodyDiagnostics`, and the global scope and bound program take the compilation's build gate. Concurrent first readers wait for one bind (ADR-0212 §8). `Emit` gets the bound program through the gate, but the lowering and emit steps after it run outside the gate. Concurrent `Emit` calls on one compilation are not verified.
- `SyntaxTree` and `SourceText` are immutable after `Parse` and `From`.
- `ReferenceResolver` keeps its caches in concurrent collections and locks. Some symbol caches are process-wide (`ClrTypeUtilities`, `FunctionTypeSymbol`, issue #1622). `ReferenceResolver.Dispose()` clears these process-wide caches.

The proposed contract is:

1. A host can share one `ReferenceResolver` between concurrent `Compilation` objects.
2. A host must not call `ReferenceResolver.Dispose()` while any compilation in the process runs, because it clears process-wide caches.
3. A host must not change process-wide state (`GSHARP_SDK_TOOLS_DIR`, and `SdkToolsDirectory` until D4) while a compilation runs.

Item 1 is not yet verified. Before the documentation calls it supported, add a stress test that binds and emits many compilations in parallel against one resolver and compares each result with a serial run. Until then, hosts must serialize compilations that share a resolver, as Oats does.

### D6. Diagnostics that a host sees once

`gsc` and library hosts must report each problem once. Parse-error cascade suppression and the GS0640 property-initializer diagnostic are separate changes. `EmitResult.Diagnostics` repeats the `GetDiagnostics()` results; the package documentation states this so that a host uses one list.

## Consequences

- A host can report GS0634 and GS9998 the same way as `gsc` with no reflection.
- The public API snapshot grows by two members.
- D2 to D4 need SDK packaging and resolver changes. Each gets its own issue and PR, and D2 needs the release workflow to publish a second package.
- D5 commits the project to keeping the gate-based `Compilation` concurrency model.

## Alternatives considered

- **A new facade type (`CompilerSession`) instead of public members.** A facade can hide phases and positions behind a stable surface. It is a larger API to design and keep stable before 1.0. The proposal can come back after D2 to D4 give a host the necessary pieces.
- **`Compilation.GetDiagnostics(includeEntryPoint: true)`.** This puts the output kind into a diagnostics query. `IsLibrary` already records the output kind, so exposing the existing query is smaller.
- **A public static setter for `SdkToolsDirectory`.** This is a small change, but it keeps process-wide state that two hosts in one process cannot share. D4 is preferred.
