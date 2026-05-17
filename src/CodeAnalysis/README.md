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

All of the above base types are `internal` in upstream Roslyn. We can subclass them because the **`Gsharp.Microsoft.CodeAnalysis`** fork (vendored as a git submodule at `src/Roslyn/`, see [its README](../Roslyn/README-GSHARP.md)) adds `InternalsVisibleTo("Gsharp.CodeAnalysis")` and `InternalsVisibleTo("gsc")` keyed to the Roslyn "Open" strong-name key — which is why this csproj signs with that same key (`<StrongNameKeyId>Open</StrongNameKeyId>`, injected by Arcade).

The fork is currently based on upstream `dotnet/roslyn` at tag `Visual-Studio-2022-Version-17.14.30` (built with .NET SDK 9.0.107 + Arcade 9.0). Rebasing onto a newer Roslyn tag is intentionally trivial — the fork patches only one csproj.

## Local development workflow

```sh
# 1. One-time: install the SDK the Roslyn fork pins (does NOT replace your default SDK).
curl -sSL https://dot.net/v1/dotnet-install.sh \
  | bash -s -- --channel 9.0 --version 9.0.107 --install-dir $HOME/.dotnet9

# 2. Build & pack the Roslyn fork NuGet (after each fork update):
export PATH="$HOME/.dotnet9:$PATH"
cd src/Roslyn
./eng/build.sh -r -b --pack -c Release \
  --solution src/Compilers/Core/Portable/Microsoft.CodeAnalysis.csproj \
  /p:WarningsNotAsErrors=NU1603 /p:MSBuildTreatWarningsAsErrors=false
cp ./artifacts/packages/Release/Shipping/Gsharp.Microsoft.CodeAnalysis.*.nupkg ../../.nugs/

# 3. Build GSharp with the fork enabled:
cd ../..
dotnet build src/CodeAnalysis/Gsharp.CodeAnalysis.csproj /p:GsharpRoslynForkAvailable=true
```

By default `GsharpRoslynForkAvailable` is `false`, which compiles the project against a stub so the rest of the solution keeps building. Phase 1 will flip the default to `true` once the Roslyn-derived members are implemented.

## Status

Phase 1 of the GSharp → .NET emit pipeline. See `~/.copilot/session-state/.../plan.md` (or the project-level design notes once they are merged) for the full roadmap.
