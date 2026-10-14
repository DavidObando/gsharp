// <copyright file="ProjectDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq

/// Discovers GSharp projects and their source files within a workspace.
shared class ProjectDiscovery {
    /// Scans the workspace root for all `.gsproj` files and discovers their source files.
    /// @param workspaceRoot Absolute path to the workspace root directory.
    /// @returns A list of discovered projects.
    func DiscoverProjects(workspaceRoot string) IReadOnlyList[DiscoveredProject] {
        if string.IsNullOrEmpty(workspaceRoot) || !Directory.Exists(workspaceRoot) {
            return Array.Empty[DiscoveredProject]()
        }
        let gsprojFiles = Directory.GetFiles(workspaceRoot, "*.gsproj", SearchOption.AllDirectories)
        let results = List[DiscoveredProject]()
        for gsprojPath in gsprojFiles {
            let project DiscoveredProject? = DiscoverProject(gsprojPath)
            if project != nil {
                results.Add(project)
            }
        }
        return results
    }

    /// Discovers source files and references for a single `.gsproj` file.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @returns The discovered project, or null if the file could not be read.
    func DiscoverProject(projectFilePath string) DiscoveredProject? {
        if !File.Exists(projectFilePath) {
            return nil
        }
        let projectDir = Path.GetDirectoryName(Path.GetFullPath(projectFilePath)) ?? string.Empty
        let sourceFiles = DiscoverSourceFiles(projectFilePath, projectDir)
        let projectReferences = DiscoverProjectReferences(projectFilePath, projectDir)
        let (references, referenceSourcePath) = DiscoverReferences(projectFilePath, projectDir)
        let assemblyName = ResolveAssemblyName(projectFilePath)
        let targetFramework = ResolveTargetFramework(projectFilePath)
        let rootNamespace = ResolveRootNamespace(projectFilePath, assemblyName)
        return DiscoveredProject(
            Path.GetFullPath(projectFilePath),
            sourceFiles,
            projectReferences,
            references,
            referenceSourcePath,
            assemblyName,
            targetFramework,
            rootNamespace
        )
    }

    /// Parses `/r:` and `/reference:` lines from an MSBuild-style
    /// response file. Mirrors the switch parsing in
    /// `GSharp.Compiler.Program.ParseCommandLine` for the subset of
    /// arguments the language server cares about. Exposed for
    /// (cref:ProjectState) to refresh references when the response file
    /// is rewritten between project rediscoveries (e.g. after a fresh
    /// `dotnet build`).
    /// @param rspPath Absolute path to the response file.
    /// @returns Absolute reference paths; empty if the file cannot be read.
    internal func ParseReferencesFromResponseFile(rspPath string) IReadOnlyList[
        string
    ] -> ParseSwitchValuesFromResponseFile(rspPath, "r", "reference")

    /// Parses the `/gsanalyzer:` lines out of an MSBuild-emitted
    /// response file — the project's G# analyzer set (ADR-0169).
    /// @param rspPath Absolute path to the `.rsp` file.
    /// @returns The analyzer assembly paths, in rsp order.
    internal func ParseGsAnalyzersFromResponseFile(rspPath string) IReadOnlyList[
        string
    ] -> ParseSwitchValuesFromResponseFile(rspPath, "gsanalyzer")

    internal func DiscoverReferences(projectFilePath string, projectDir string)(
        References IReadOnlyList[string],
        ReferenceSourcePath string?
    ) -> DiscoverReferencesCore(projectFilePath, projectDir)

    /// Resolves the project's effective `AssemblyName`, which the SDK uses
    /// as the base of the response-file name. Defaults to the project file's
    /// base name (matching MSBuild's `$(TargetName)` default).
    /// @param projectFilePath Absolute path to the `.gsproj`.
    /// @returns The effective `AssemblyName`; never `null`.
    internal func ResolveAssemblyName(projectFilePath string) string {
        let defaultName = Path.GetFileNameWithoutExtension(projectFilePath)
        try {
            let doc = XDocument.Load(projectFilePath)
            let explicitName = doc
                .Descendants()
                .FirstOrDefault((e XElement) -> e.Name.LocalName == "AssemblyName")
                ?.Value
            if !string.IsNullOrWhiteSpace(explicitName) {
                return explicitName.Trim()
            }
        } catch (Exception) {
            // Fall through to the default below.

        }
        return defaultName
    }

    /// Resolves the project's target framework moniker (e.g. `net8.0`) from
    /// the `.gsproj`. Returns the single `<TargetFramework>` when
    /// present, otherwise the raw `<TargetFrameworks>` value (so a
    /// multi-targeting change still flips the cold-start cache fingerprint), or an
    /// empty string when neither is declared or the file cannot be parsed. Used by
    /// ADR-0107 as one component of the cold-start cache fingerprint.
    /// @param projectFilePath Absolute path to the `.gsproj`.
    /// @returns The target framework moniker; never `null`.
    internal func ResolveTargetFramework(projectFilePath string) string {
        try {
            let doc = XDocument.Load(projectFilePath)
            let single = doc.Descendants().FirstOrDefault((e XElement) -> e.Name.LocalName == "TargetFramework")?.Value
            if !string.IsNullOrWhiteSpace(single) {
                return single.Trim()
            }
            let multi = doc.Descendants().FirstOrDefault((e XElement) -> e.Name.LocalName == "TargetFrameworks")?.Value
            if !string.IsNullOrWhiteSpace(multi) {
                return multi.Trim()
            }
        } catch (Exception) {
            // Fall through to the empty default below.

        }
        return string.Empty
    }

    /// Resolves the project's effective `RootNamespace` — used by the resx
    /// codebehind generator (ADR-0142, issue #2200) to compute the default
    /// namespace for a `Resources.Designer.gs` file, matching MSBuild's own
    /// `RootNamespace` default (falling back to [`assemblyName`](paramref),
    /// which itself defaults to the project file's base name).
    /// @param projectFilePath Absolute path to the `.gsproj`.
    /// @param assemblyName The project's already-resolved (cref:DiscoveredProject.AssemblyName),
    /// used as the fallback when no `<RootNamespace>` is declared.
    /// @returns The effective root namespace; never `null`.
    internal func ResolveRootNamespace(projectFilePath string, assemblyName string) string {
        try {
            let doc = XDocument.Load(projectFilePath)
            let explicitNamespace = doc
                .Descendants()
                .FirstOrDefault((e XElement) -> e.Name.LocalName == "RootNamespace")
                ?.Value
            if !string.IsNullOrWhiteSpace(explicitNamespace) {
                return explicitNamespace.Trim()
            }
        } catch (Exception) {
            // Fall through to the AssemblyName-derived default below.

        }
        return (assemblyName ?? Path.GetFileNameWithoutExtension(projectFilePath))
    }

    /// Discovers generator-produced G# source parts under the project's intermediate
    /// output directory. The SDK writes source-generator output to
    /// `$(IntermediateOutputPath)gsgen/*.g.gs` (e.g. `obj/Debug/net10.0/gsgen/`)
    /// and injects it into `@(Compile)`; because the language server's normal
    /// `**/*.gs` glob excludes `obj/`, these generated parts would otherwise be
    /// invisible. This scans the project's `obj/` tree for `*.g.gs` files that
    /// sit under a `gsgen` segment so generated members resolve in the editor after a
    /// build (ADR-0145 §G). The language server never runs the generator itself here — live
    /// in-editor regeneration is a separate increment.
    /// @param projectDir The project directory to scan.
    /// @returns Absolute paths of generated G# source parts; empty when none exist.
    internal func DiscoverGeneratedSourceFiles(projectDir string) IReadOnlyList[string] {
        if string.IsNullOrEmpty(projectDir) {
            return Array.Empty[string]()
        }
        let objDir = Path.Combine(projectDir, "obj")
        if !Directory.Exists(objDir) {
            return Array.Empty[string]()
        }
        var candidates[]string
        try {
            candidates = Directory.GetFiles(objDir, "*.g.gs", SearchOption.AllDirectories)
        } catch (DirectoryNotFoundException) {
            return Array.Empty[string]()
        } catch (UnauthorizedAccessException) {
            return Array.Empty[string]()
        }
        return candidates.Where(IsGeneratedSourcePath).Select(Path.GetFullPath).ToList()
    }

    /// Returns whether [`filePath`](paramref) is a generator-produced G# source
    /// part — a `*.g.gs` file living under a `gsgen` directory segment
    /// (ADR-0145 §G). Used by both project discovery and the watched-file handler so the
    /// language server treats these `obj/`-resident parts as real source even though
    /// the rest of `obj/` is excluded.
    /// @param filePath Absolute or relative path to test.
    /// @returns `true` when the path is a gsgen-produced `*.g.gs` part.
    internal func IsGeneratedSourcePath(filePath string) bool {
        if string.IsNullOrEmpty(filePath) || !filePath.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase) {
            return false
        }
        let parts = filePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        return parts.Any((p string) -> string.Equals(p, "gsgen", StringComparison.OrdinalIgnoreCase))
    }

    /// Discovers all `.gs` source files for a project directory using the
    /// SDK default glob pattern (`**/*.gs`), excluding common output directories.
    /// @param projectFilePath Path to the `.gsproj` file.
    /// @param projectDir The project directory to glob.
    /// @returns A list of absolute source file paths.
    private func DiscoverSourceFiles(projectFilePath string, projectDir string) IReadOnlyList[string] {
        if !Directory.Exists(projectDir) {
            return Array.Empty[string]()
        }
        var sources List[string]
        if IsDefaultCompileItemsDisabled(projectFilePath) {
            // When default items are disabled, look for explicit <Compile> items.
            sources = GetExplicitCompileItems(projectFilePath, projectDir).ToList()
        } else {
            // Default: glob **/*.gs, excluding bin/obj directories.
            sources = Directory
                .GetFiles(projectDir, "*.gs", SearchOption.AllDirectories)
                .Where((f string) -> !IsInExcludedDirectory(f, projectDir))
                .Select(Path.GetFullPath)
                .ToList()
        }
        // ADR-0145 §G (v1 slice): the SDK's `_GsharpRunSourceGenerators` target writes
        // generator output to `$(IntermediateOutputPath)gsgen/*.g.gs` (typically
        // `obj/Debug/net10.0/gsgen/`) and injects it into @(Compile). The globs above
        // deliberately exclude `obj/`, so those generated parts would never be seen by
        // the language server and their members would show as unresolved in the editor
        // even after a successful build. Re-add the gsgen output here (and ONLY the
        // gsgen output — the rest of obj/ stays excluded) so generated members resolve
        // post-build. Deduplicated so an explicit <Compile> that already names a
        // generated part is not added twice.
        let generated = DiscoverGeneratedSourceFiles(projectDir)
        if generated.Count > 0 {
            let seen = HashSet[string](sources, StringComparer.OrdinalIgnoreCase)
            for g in generated {
                if seen.Add(g) {
                    sources.Add(g)
                }
            }
        }
        return sources
    }

    /// Discovers project references from a `.gsproj` file.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param projectDir The project directory for resolving relative paths.
    /// @returns A list of absolute paths to referenced `.gsproj` files.
    private func DiscoverProjectReferences(projectFilePath string, projectDir string) IReadOnlyList[string] {
        try {
            let doc = XDocument.Load(projectFilePath)
            let refs = doc
                .Descendants()
                .Where((e XElement) -> e.Name.LocalName == "ProjectReference")
                .Select((e XElement) -> e.Attribute(XName?("Include")!!)?.Value)
                .OfType[string]()
                .Where((v string) -> v.Length > 0)
                .Select((v string) -> Path.GetFullPath(Path.Combine(projectDir, v)))
                .ToList()
            return refs
        } catch (Exception) {
            return Array.Empty[string]()
        }
    }

    /// Discovers external assembly references for a project by parsing the most
    /// recently written MSBuild response file under `obj/`. The SDK writes
    /// the same `/r:` list it passes to the compiler to
    /// `$(IntermediateOutputPath)$(TargetName).rsp`; the language server
    /// reads that file so completion, hover, and diagnostics see the same
    /// imported CLR types as the command-line build.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param projectDir The project directory.
    /// @returns The discovered references plus the source `.rsp` path. Both are empty/null when no response
    /// file has been produced (e.g. the project has not been built or restored yet).
    private func DiscoverReferencesCore(projectFilePath string, projectDir string)(
        References IReadOnlyList[string],
        ReferenceSourcePath string?
    ) {
        if !Directory.Exists(projectDir) {
            return (Array.Empty[string](), nil)
        }
        let objDir = Path.Combine(projectDir, "obj")
        if !Directory.Exists(objDir) {
            return (Array.Empty[string](), nil)
        }
        let rspName = ResolveAssemblyName(projectFilePath) + ".rsp"
        var candidates[]string
        try {
            candidates = Directory.GetFiles(objDir, rspName, SearchOption.AllDirectories)
        } catch (DirectoryNotFoundException) {
            return (Array.Empty[string](), nil)
        } catch (UnauthorizedAccessException) {
            return (Array.Empty[string](), nil)
        }
        if candidates.Length == 0 {
            return (Array.Empty[string](), nil)
        }
        // Multi-targeted or multi-configuration projects produce one .rsp per (TFM, Configuration).
        // Pick the most recently written so the LSP tracks whatever the user last built.
        let rspPath = candidates.OrderByDescending(
            (p string) -> {
                try {
                    return File.GetLastWriteTimeUtc(p)
                } catch (IOException) {
                    return DateTime.MinValue
                }
            }
        )
            .First()
        let references = ParseReferencesFromResponseFile(rspPath)
        return (references, Path.GetFullPath(rspPath))
    }

    private func IsDefaultCompileItemsDisabled(projectFilePath string) bool {
        try {
            let doc = XDocument.Load(projectFilePath)
            let element XElement? = doc.Descendants().FirstOrDefault(
                (e XElement) -> e.Name.LocalName == "EnableDefaultCompileItems"
            )
            return element != nil && string.Equals(element.Value, "false", StringComparison.OrdinalIgnoreCase)
        } catch (Exception) {
            return false
        }
    }

    private func GetExplicitCompileItems(projectFilePath string, projectDir string) IReadOnlyList[string] {
        try {
            let doc = XDocument.Load(projectFilePath)
            return doc
                .Descendants()
                .Where((e XElement) -> e.Name.LocalName == "Compile")
                .Select((e XElement) -> e.Attribute(XName?("Include")!!)?.Value)
                .OfType[string]()
                .Select((v string) -> Path.GetFullPath(Path.Combine(projectDir, v)))
                .Where(File.Exists)
                .ToList()
        } catch (Exception) {
            return Array.Empty[string]()
        }
    }

    private func IsInExcludedDirectory(filePath string, projectDir string) bool {
        let relativePath = Path.GetRelativePath(projectDir, filePath)
        let parts = relativePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        return parts.Any(
            (p string) -> string.Equals(p, "bin", StringComparison.OrdinalIgnoreCase) || string.Equals(
                p,
                "obj",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    private func ParseSwitchValuesFromResponseFile(rspPath string, switchNames ...string) IReadOnlyList[string] {
        var lines[]string
        try {
            lines = File.ReadAllLines(rspPath)
        } catch (IOException) {
            return Array.Empty[string]()
        } catch (UnauthorizedAccessException) {
            return Array.Empty[string]()
        }
        let refs = List[string](lines.Length)
        for raw in lines {
            var trimmed = raw?.Trim()
            if string.IsNullOrEmpty(trimmed) {
                continue
            }
            // MSBuild on Windows may quote entire switch lines when values contain
            // spaces (e.g. "/r:C:\Program Files\..."). Strip outer quotes first.
            if trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"' {
                trimmed = trimmed.Substring(1, trimmed.Length - 2)
            }
            if !(trimmed!![0] == '/' || trimmed!![0] == '-') {
                continue
            }
            let body = trimmed!!.Substring(1)
            let colon = body.IndexOf(':')
            if colon < 0 {
                continue
            }
            let name = body.Substring(0, colon)
            if !switchNames.Any(
                (switchName string) -> string.Equals(name, switchName, StringComparison.OrdinalIgnoreCase)
            ) {
                continue
            }
            var value = body.Substring(colon + 1).Trim()
            if value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"' {
                value = value.Substring(1, value.Length - 2)
            }
            if value.Length > 0 {
                refs.Add(value)
            }
        }
        return refs
    }
}
