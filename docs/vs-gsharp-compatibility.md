# G# Visual Studio compatibility

Validated on Visual Studio Enterprise 2026 `18.8.12009.203` ARM64 with
.NET SDK `10.0.302`, runtime `10.0.10`, and VSIX `0.3.198.40000`. The
automated parity run used source revision `9c40a3a3` plus the working-tree
extension changes.

| Surface | Result |
| --- | --- |
| VSIX load | Package and MEF components load in an isolated root suffix |
| Editor | `.gs` opens as G# and starts the bundled LSP server |
| LSP | Completion, hover, signature help, navigation, references, symbols, actions, formatting, rename, folding, semantic tokens, diagnostics, and inlay hints are advertised by dev18 |
| Status | Native status bar reports server transitions and the active G# project |
| Project system | `.gsproj` loads as CPS with managed, dependency, NuGet, launch-profile, and test capabilities |
| Generated files | `<AssemblyName>.gsproj.lscache` remains on disk but is excluded from Solution Explorer |
| Restore/build | Native solution restore and build succeed |
| Debugging | Native managed F5 builds and launches the console sample |
| Test Explorer | Visual Studio's VSTest runner discovers all 16 xUnit, NUnit, and MSTest fixture cases; selected runs, skips, failures, refresh, cancellation, and portable PDBs pass. Interactive source navigation and Debug Selected remain manual UI gates |
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

The language server exposes `gsharp/referenceCodeLens`. It returns declaration
ranges, reference counts, and reference locations from the same
`CodeLensComputer` used by `textDocument/codeLens`; the in-process
`GSharpLanguageServerRpc` facade has a typed request for that method. The
in-process tagger requests one document result after edits, suppresses stale
responses, and creates native `ICodeLensTag3` tags without compiler or binder
logic.

Visual Studio 18.8's modern `ICodeLensProvider` remains a preview,
out-of-process `VisualStudio.Extensibility` API and cannot import the classic
`net472` VSIX's MEF RPC facade. G# therefore uses the stable classic API:
`GSharp.VisualStudio.CodeLens.dll` is packaged as a
`Microsoft.VisualStudio.CodeLensComponent`, and its
`IAsyncCodeLensDataPointProvider` consumes the descriptors emitted by the
in-process tagger. The platform-provided `ICodeLensCallbackService` routes a
lens click back to the VSIX, which places the caret on the declaration and
executes Visual Studio's native **Find All References** command. No second
language server or custom IPC transport is used.

SDK references:

- [VisualStudio.Extensibility CodeLens walkthrough](https://learn.microsoft.com/visualstudio/extensibility/visualstudio.extensibility/editor/walkthroughs/codelens)
- [Official modern CodeLens sample](https://github.com/microsoft/VSExtensibility/tree/main/New_Extensibility_Model/Samples/CodeLensSample)
- [Official classic out-of-process CodeLens sample](https://github.com/microsoft/VSSDK-Extensibility-Samples/tree/master/CodeLensOopSample)

## Experimental profile cache

Each root suffix has its own profile directory. The install script removes
`ComponentModelCache`, `MEFCacheBackup`, and the extension metadata packs only
from the profile matching the selected suffix. It also resets
`InstalledTemplates.json`, `NpdProjectTemplateCache_*`,
`ItemTemplatesCache_*`, and `ProjectTemplatesCache_*`, which otherwise omit
newly installed templates. It then launches that suffix once without a
solution so MEF discovery finishes before project loading.
