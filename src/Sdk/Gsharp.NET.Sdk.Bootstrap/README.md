# Gsharp.NET.Sdk.Bootstrap

Issue #792 / ADR-0084. A *build-time-only* mirror of `Gsharp.NET.Sdk` that
compiles `.gs` sources against the **in-tree** `gsc.dll` (Compiler.csproj
output) and BuildTask DLL (Gsharp.NET.Sdk.csproj output) **without** the
auto-reference to `Gsharp.Extensions.dll` that the consumer-facing SDK
sets up.

The bootstrap exists so `Gsharp.Extensions.dll` itself can be authored in
`.gs`: the consumer SDK ships `Gsharp.Extensions.dll` inside its NuGet
(`tools/extensions/`) and auto-references it from every consumer
`.gsproj`, which creates a build cycle (SDK → Extensions → SDK) the
moment a `.gsproj` for `Gsharp.Extensions` itself tries to consume the
SDK. The bootstrap breaks the cycle by being *equivalent* to the
consumer SDK on every other axis (same BuildTask, same gsc invocation,
same `_ExplicitReference` plumbing) except for the auto-reference.

There is no NuGet pack here — this is a directory of `.targets` files
imported directly by in-tree relative path. The intended consumer is a
`.gsproj` living in this repository (today exercised by
`samples/BootstrapSdkSample/`, and in the future by a G#-authored
`Gsharp.Extensions` once the language gaps tracked from #792 close).

## Build ordering

`dotnet build GSharp.sln` walks the topology:

1. `src/Compiler/Compiler.csproj` — produces `gsc.dll`.
2. `src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj` — produces the BuildTask
   DLL (and packs the consumer SDK NuGet, currently still bundling the
   C# `Gsharp.Extensions.dll`).
3. Any `.gsproj` consuming this bootstrap.

## Layout

- `build/Gsharp.NET.Sdk.Bootstrap.targets` — single targets file imported
  from a `.gsproj` AFTER `Microsoft.NET.Sdk`'s `Sdk.targets`. Resolves
  `GsharpToolFullPath` / `GsharpCompilerFullPath` from the in-tree build
  outputs (`out/bin/$(Configuration)/...`), registers the `BuildTask`
  via `<UsingTask>`, and overrides `CoreCompile` to call gsc. Mirrors
  `Gsharp.NET.Core.Sdk.targets` in the consumer SDK but does **not** set
  `_ExplicitReference` for `Gsharp.Extensions.dll` — that auto-reference
  is exactly the cycle this bootstrap exists to break.

Consumers (today only `samples/BootstrapSdkSample/`) wire the bootstrap
into a `.gsproj` like this:

```xml
<Project>
  <PropertyGroup>
    <Language>Gsharp</Language>
    <DefaultLanguageSourceExtension>.gs</DefaultLanguageSourceExtension>
  </PropertyGroup>

  <Import Sdk="Microsoft.NET.Sdk" Project="Sdk.props" />
  <Import Sdk="Microsoft.NET.Sdk" Project="Sdk.targets" />
  <Import Project="..\..\src\Sdk\Gsharp.NET.Sdk.Bootstrap\build\Gsharp.NET.Sdk.Bootstrap.targets" />
</Project>
```

## Why not a separate SDK NuGet?

A NuGet would add a packaging round-trip to the bootstrap (publish a
stage-0 SDK, then use it). The bootstrap is purely a build-time helper
the repo never ships, so importing `.props` / `.targets` directly by
relative path is simpler, faster, and avoids polluting the public
package surface.
