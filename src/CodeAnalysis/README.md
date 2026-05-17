# Gsharp.CodeAnalysis

Roslyn-derived semantic and PE-emit layer for the GSharp compiler.

This project bridges the existing GSharp front-end (`GSharp.Core` — lexer, parser, binder, lowering) to Roslyn's symbol/metadata/emit machinery in order to produce real .NET assemblies.

## Architecture

| Layer | Type | Base type |
|---|---|---|
| Compilation | `GsharpCompilation` | `Microsoft.CodeAnalysis.Compilation` |
| Symbols | `GsharpAssemblySymbol`, `GsharpNamespaceSymbol`, `GsharpTypeSymbol`, `GsharpMethodSymbol`, … | `Microsoft.CodeAnalysis.Symbol` and friends |
| PE emit | `Emitter.PEModuleBuilder` | `Microsoft.Cci.CommonPEModuleBuilder` |
| Code gen | `CodeGen.MethodGenerator` | uses `Microsoft.CodeAnalysis.CodeGen.ILBuilder` |
| CLI driver | `CommandLine.GsharpCompiler` | `Microsoft.CodeAnalysis.CommonCompiler` |

All of the above base types are `internal` in upstream Roslyn. We can subclass them because the **`Gsharp.Microsoft.CodeAnalysis`** fork (vendored as a git submodule at `src/Roslyn/`, see [its README](../Roslyn/README.md)) adds `InternalsVisibleTo("Gsharp.CodeAnalysis")` keyed to the Roslyn "Open" strong-name key — which is why this csproj signs with that same key.

## Local development workflow

```sh
# 1. Build the Roslyn fork NuGet (one-time, or after rebasing the fork):
cd src/Roslyn && ./GsharpNuget.sh
cp ./artifacts/packages/Release/Shipping/Gsharp.Microsoft.CodeAnalysis.3.7.4.nupkg ../../.nugs/

# 2. Build GSharp normally:
cd ../..
dotnet restore
dotnet build src/CodeAnalysis/Gsharp.CodeAnalysis.csproj
```

## Status

Phase 1 of the GSharp → .NET emit pipeline. See `~/.copilot/session-state/.../plan.md` (or the project-level design notes once they are merged) for the full roadmap.
