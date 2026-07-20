# G# Visual Studio compatibility

Validated on Visual Studio Enterprise 2026 `18.8.12009.203` ARM64 with
.NET SDK `10.0.302`, runtime `10.0.10`, and VSIX `0.3.159`. The final
normal-profile acceptance run used source revision `7e7fd013` plus the
working-tree extension changes.

| Surface | Result |
| --- | --- |
| VSIX load | Package and MEF components load in an isolated root suffix and the normal per-user profile |
| Editor | `.gs` opens as G# and starts the bundled LSP server |
| LSP | Completion, hover, signature help, navigation, references, symbols, actions, formatting, rename, folding, semantic tokens, diagnostics, and inlay hints are advertised by dev18 |
| Status | Native status bar reports server transitions and the active G# project |
| Project system | `.gsproj` loads as CPS with managed, dependency, NuGet, launch-profile, and test capabilities |
| Generated files | `<AssemblyName>.gsproj.lscache` remains on disk but is excluded from Solution Explorer |
| Restore/build | Native solution restore and build succeed |
| Debugging | Native managed F5 builds and launches the console sample |
| Test Explorer | xUnit adapter discovers 3 tests, runs 3/3, and supports Debug All under .NET 10; NUnit and MSTest adapter smoke tests pass |
| Templates | Console, library, web, and xUnit projects plus four item templates are indexed; New Project and Add New Item outputs rebuild |
| Themes | Six generated light/dark themes are packaged |
| Snippets | Generated Visual Studio snippets match the VS Code source |

## Test Explorer compatibility

Visual Studio's legacy VSTest launcher does not infer a target framework for
non-C#/VB CPS projects. Test projects built by `Gsharp.NET.Sdk` therefore
generate an absolute project-level `RunSettingsFilePath` containing the
evaluated target framework. Standard framework adapters consume it without a
custom G# test adapter.

G# assemblies also emit `TargetFrameworkAttribute`, including reference
assemblies, so tooling can identify the target outside Visual Studio.

## LSP host limitation

Dev18 does not advertise `codeLens` or `selectionRange`. Their operations
remain available through Visual Studio's native **Find All References**
(`Shift+F12`), **Expand Selection**, and **Contract Selection** commands.
The extension deliberately does not ship a second, lexically approximated
reference or syntax engine solely to reproduce the missing inline count
adornment or LSP selection hierarchy.

## Experimental profile cache

Each root suffix has its own profile directory. The install script removes
`ComponentModelCache`, `MEFCacheBackup`, and the extension metadata packs only
from the profile matching the selected suffix. It also resets
`InstalledTemplates.json`, `NpdProjectTemplateCache_*`,
`ItemTemplatesCache_*`, and `ProjectTemplatesCache_*`, which otherwise omit
newly installed templates. It then launches that suffix once without a
solution so MEF discovery finishes before project loading.
