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

## Settings and commands

`Tools > Options > G#` controls the server lifecycle, formatting, on-type
diagnostics, completion-on-dot, reference CodeLens, and parameter/type inlay
hints. Language feature changes take effect after **Restart Language Server**.

`Tools > G#` contains **Restart Language Server**, **Show Output**, and
**Report Issue**. Build, restore, run, debug, and tests use Visual Studio's
native commands. Server transitions and the active project are shown
transiently in Visual Studio's status bar and recorded in the G# output pane.
