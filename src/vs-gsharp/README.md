# G# for Visual Studio

The G# Visual Studio extension provides:

- `.gs` editing through the bundled G# language server
- first-class CPS support for `.gsproj` projects
- native build, restore, NuGet, F5, and managed debugging
- native Test Explorer support for xUnit, NUnit, and MSTest adapters
- the six G# Ember, Magma, and Synthwave light/dark themes
- snippets generated from the VS Code extension

Visual Studio 2026 or later is supported. The .NET 10 runtime is required by
the bundled language server and G# SDK projects.

## Build

Run from a Visual Studio Developer PowerShell:

```powershell
msbuild src\vs-gsharp\VsGsharp.sln /restore /t:Build /p:Configuration=Release
```

The VSIX is written to
`src\vs-gsharp\src\VsGsharp\bin\Release\net472\GSharp.VisualStudio.vsix`.

## Experimental instance

```powershell
src\vs-gsharp\scripts\Install-ExperimentalVsix.ps1 -RootSuffix GSharp
src\vs-gsharp\scripts\Invoke-Vs2026Smoke.ps1 `
  -RootSuffix GSharp `
  -SolutionPath path\to\sample.sln
```

The installer removes only the selected experimental profile's MEF,
extension metadata, and project-template indexes, then warms that profile
before a solution is opened.

## Settings and commands

`Tools > Options > G#` controls the server lifecycle, formatting, on-type
diagnostics, completion-on-dot, reference CodeLens, and parameter/type inlay
hints. Language feature changes take effect after **Restart Language Server**.

`Tools > G#` contains **Restart Language Server**, **Show Output**, and
**Report Issue**. Build, restore, run, debug, and tests use Visual Studio's
native commands. Server transitions and the active project are shown
transiently in Visual Studio's status bar and recorded in the G# output pane.
