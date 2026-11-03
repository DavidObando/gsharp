# Gsharp.NET.Sdk.Compiler

The ReadyToRun `gsc` compiler for the [GSharp programming language](https://github.com/DavidObando/gsharp), for one runtime identifier (RID).
The package ID ends with the RID: `linux-x64`, `linux-arm64`, `win-x64`, `win-arm64`, `osx-x64` or `osx-arm64`.

## Do not reference this package

Reference [Gsharp.NET.Sdk](https://www.nuget.org/packages/Gsharp.NET.Sdk) instead.
The SDK restores the package for the host RID with `PackageDownload`, at the exact SDK version.
It then starts this `gsc` in place of the portable IL `gsc` in the SDK package.
Other hosts, and Visual Studio's .NET Framework MSBuild, use the portable `gsc`.

## Opt out

Set this property in the project to use the portable `gsc` and restore no compiler package:

```xml
<PropertyGroup>
  <GsharpUseReadyToRunCompiler>false</GsharpUseReadyToRunCompiler>
</PropertyGroup>
```

## Learn More

- [Documentation](https://davidobando.github.io/gsharp/)
- [ADR-0207: ReadyToRun compiler payloads and RID selection](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0207-readytorun-compiler-payloads-and-rid-selection.md)
- [License (MIT)](https://github.com/DavidObando/gsharp/blob/main/LICENSE)
