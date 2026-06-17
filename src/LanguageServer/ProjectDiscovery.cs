// <copyright file="ProjectDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace GSharp.LanguageServer;

/// <summary>
/// Discovers GSharp projects and their source files within a workspace.
/// </summary>
public static class ProjectDiscovery
{
    /// <summary>
    /// Scans the workspace root for all <c>.gsproj</c> files and discovers their source files.
    /// </summary>
    /// <param name="workspaceRoot">Absolute path to the workspace root directory.</param>
    /// <returns>A list of discovered projects.</returns>
    public static IReadOnlyList<DiscoveredProject> DiscoverProjects(string workspaceRoot)
    {
        if (string.IsNullOrEmpty(workspaceRoot) || !Directory.Exists(workspaceRoot))
        {
            return Array.Empty<DiscoveredProject>();
        }

        var gsprojFiles = Directory.GetFiles(workspaceRoot, "*.gsproj", SearchOption.AllDirectories);
        var results = new List<DiscoveredProject>();

        foreach (var gsprojPath in gsprojFiles)
        {
            var project = DiscoverProject(gsprojPath);
            if (project != null)
            {
                results.Add(project);
            }
        }

        return results;
    }

    /// <summary>
    /// Discovers source files and references for a single <c>.gsproj</c> file.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <returns>The discovered project, or null if the file could not be read.</returns>
    public static DiscoveredProject DiscoverProject(string projectFilePath)
    {
        if (!File.Exists(projectFilePath))
        {
            return null;
        }

        var projectDir = Path.GetDirectoryName(Path.GetFullPath(projectFilePath));
        var sourceFiles = DiscoverSourceFiles(projectFilePath, projectDir);
        var projectReferences = DiscoverProjectReferences(projectFilePath, projectDir);
        var (references, referenceSourcePath) = DiscoverReferences(projectFilePath, projectDir);
        var assemblyName = ResolveAssemblyName(projectFilePath);
        var targetFramework = ResolveTargetFramework(projectFilePath);

        return new DiscoveredProject(
            Path.GetFullPath(projectFilePath),
            sourceFiles,
            projectReferences,
            references,
            referenceSourcePath,
            assemblyName,
            targetFramework);
    }

    /// <summary>
    /// Parses <c>/r:</c> and <c>/reference:</c> lines from an MSBuild-style
    /// response file. Mirrors the switch parsing in
    /// <c>GSharp.Compiler.Program.ParseCommandLine</c> for the subset of
    /// arguments the language server cares about. Exposed for
    /// <see cref="ProjectState"/> to refresh references when the response file
    /// is rewritten between project rediscoveries (e.g. after a fresh
    /// <c>dotnet build</c>).
    /// </summary>
    /// <param name="rspPath">Absolute path to the response file.</param>
    /// <returns>Absolute reference paths; empty if the file cannot be read.</returns>
    internal static IReadOnlyList<string> ParseReferencesFromResponseFile(string rspPath)
    {
        string[] lines;
        try
        {
            lines = File.ReadAllLines(rspPath);
        }
        catch (IOException)
        {
            return Array.Empty<string>();
        }
        catch (UnauthorizedAccessException)
        {
            return Array.Empty<string>();
        }

        var refs = new List<string>(lines.Length);
        foreach (var raw in lines)
        {
            var trimmed = raw?.Trim();
            if (string.IsNullOrEmpty(trimmed))
            {
                continue;
            }

            // MSBuild on Windows may quote entire switch lines when values contain
            // spaces (e.g. "/r:C:\Program Files\..."). Strip outer quotes first.
            if (trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"')
            {
                trimmed = trimmed.Substring(1, trimmed.Length - 2);
            }

            if (!(trimmed[0] == '/' || trimmed[0] == '-'))
            {
                continue;
            }

            var body = trimmed.Substring(1);
            var colon = body.IndexOf(':');
            if (colon < 0)
            {
                continue;
            }

            var name = body.Substring(0, colon);
            if (!string.Equals(name, "r", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(name, "reference", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var value = body.Substring(colon + 1).Trim();
            if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"')
            {
                value = value.Substring(1, value.Length - 2);
            }

            if (value.Length > 0)
            {
                refs.Add(value);
            }
        }

        return refs;
    }

    /// <summary>
    /// Resolves the project's effective <c>AssemblyName</c>, which the SDK uses
    /// as the base of the response-file name. Defaults to the project file's
    /// base name (matching MSBuild's <c>$(TargetName)</c> default).
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c>.</param>
    /// <returns>The effective <c>AssemblyName</c>; never <c>null</c>.</returns>
    internal static string ResolveAssemblyName(string projectFilePath)
    {
        var defaultName = Path.GetFileNameWithoutExtension(projectFilePath);
        try
        {
            var doc = XDocument.Load(projectFilePath);
            var explicitName = doc.Descendants()
                .FirstOrDefault(e => e.Name.LocalName == "AssemblyName")?.Value;
            if (!string.IsNullOrWhiteSpace(explicitName))
            {
                return explicitName.Trim();
            }
        }
        catch (Exception)
        {
            // Fall through to the default below.
        }

        return defaultName;
    }

    /// <summary>
    /// Resolves the project's target framework moniker (e.g. <c>net8.0</c>) from
    /// the <c>.gsproj</c>. Returns the single <c>&lt;TargetFramework&gt;</c> when
    /// present, otherwise the raw <c>&lt;TargetFrameworks&gt;</c> value (so a
    /// multi-targeting change still flips the cold-start cache fingerprint), or an
    /// empty string when neither is declared or the file cannot be parsed. Used by
    /// ADR-0107 as one component of the cold-start cache fingerprint.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c>.</param>
    /// <returns>The target framework moniker; never <c>null</c>.</returns>
    internal static string ResolveTargetFramework(string projectFilePath)
    {
        try
        {
            var doc = XDocument.Load(projectFilePath);
            var single = doc.Descendants()
                .FirstOrDefault(e => e.Name.LocalName == "TargetFramework")?.Value;
            if (!string.IsNullOrWhiteSpace(single))
            {
                return single.Trim();
            }

            var multi = doc.Descendants()
                .FirstOrDefault(e => e.Name.LocalName == "TargetFrameworks")?.Value;
            if (!string.IsNullOrWhiteSpace(multi))
            {
                return multi.Trim();
            }
        }
        catch (Exception)
        {
            // Fall through to the empty default below.
        }

        return string.Empty;
    }

    /// <summary>
    /// Discovers all <c>.gs</c> source files for a project directory using the
    /// SDK default glob pattern (<c>**/*.gs</c>), excluding common output directories.
    /// </summary>
    /// <param name="projectFilePath">Path to the <c>.gsproj</c> file.</param>
    /// <param name="projectDir">The project directory to glob.</param>
    /// <returns>A list of absolute source file paths.</returns>
    private static IReadOnlyList<string> DiscoverSourceFiles(string projectFilePath, string projectDir)
    {
        if (!Directory.Exists(projectDir))
        {
            return Array.Empty<string>();
        }

        // Check if EnableDefaultCompileItems is explicitly disabled
        if (IsDefaultCompileItemsDisabled(projectFilePath))
        {
            // When default items are disabled, look for explicit <Compile> items
            return GetExplicitCompileItems(projectFilePath, projectDir);
        }

        // Default: glob **/*.gs, excluding bin/obj directories
        return Directory.GetFiles(projectDir, "*.gs", SearchOption.AllDirectories)
            .Where(f => !IsInExcludedDirectory(f, projectDir))
            .Select(Path.GetFullPath)
            .ToList();
    }

    /// <summary>
    /// Discovers project references from a <c>.gsproj</c> file.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="projectDir">The project directory for resolving relative paths.</param>
    /// <returns>A list of absolute paths to referenced <c>.gsproj</c> files.</returns>
    private static IReadOnlyList<string> DiscoverProjectReferences(string projectFilePath, string projectDir)
    {
        try
        {
            var doc = XDocument.Load(projectFilePath);
            var refs = doc.Descendants()
                .Where(e => e.Name.LocalName == "ProjectReference")
                .Select(e => e.Attribute("Include")?.Value)
                .Where(v => !string.IsNullOrEmpty(v))
                .Select(v => Path.GetFullPath(Path.Combine(projectDir, v)))
                .ToList();
            return refs;
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// Discovers external assembly references for a project by parsing the most
    /// recently written MSBuild response file under <c>obj/</c>. The SDK writes
    /// the same <c>/r:</c> list it passes to the compiler to
    /// <c>$(IntermediateOutputPath)$(TargetName).rsp</c>; the language server
    /// reads that file so completion, hover, and diagnostics see the same
    /// imported CLR types as the command-line build.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="projectDir">The project directory.</param>
    /// <returns>The discovered references plus the source <c>.rsp</c> path. Both are empty/null when no response file has been produced (e.g. the project has not been built or restored yet).</returns>
    private static (IReadOnlyList<string> References, string ReferenceSourcePath) DiscoverReferences(string projectFilePath, string projectDir)
    {
        if (!Directory.Exists(projectDir))
        {
            return (Array.Empty<string>(), null);
        }

        var objDir = Path.Combine(projectDir, "obj");
        if (!Directory.Exists(objDir))
        {
            return (Array.Empty<string>(), null);
        }

        var rspName = ResolveAssemblyName(projectFilePath) + ".rsp";
        string[] candidates;
        try
        {
            candidates = Directory.GetFiles(objDir, rspName, SearchOption.AllDirectories);
        }
        catch (DirectoryNotFoundException)
        {
            return (Array.Empty<string>(), null);
        }
        catch (UnauthorizedAccessException)
        {
            return (Array.Empty<string>(), null);
        }

        if (candidates.Length == 0)
        {
            return (Array.Empty<string>(), null);
        }

        // Multi-targeted or multi-configuration projects produce one .rsp per (TFM, Configuration).
        // Pick the most recently written so the LSP tracks whatever the user last built.
        var rspPath = candidates
            .OrderByDescending(p =>
            {
                try
                {
                    return File.GetLastWriteTimeUtc(p);
                }
                catch (IOException)
                {
                    return DateTime.MinValue;
                }
            })
            .First();

        var references = ParseReferencesFromResponseFile(rspPath);
        return (references, Path.GetFullPath(rspPath));
    }

    private static bool IsDefaultCompileItemsDisabled(string projectFilePath)
    {
        try
        {
            var doc = XDocument.Load(projectFilePath);
            var element = doc.Descendants()
                .FirstOrDefault(e => e.Name.LocalName == "EnableDefaultCompileItems");
            return element != null && string.Equals(element.Value, "false", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static IReadOnlyList<string> GetExplicitCompileItems(string projectFilePath, string projectDir)
    {
        try
        {
            var doc = XDocument.Load(projectFilePath);
            return doc.Descendants()
                .Where(e => e.Name.LocalName == "Compile")
                .Select(e => e.Attribute("Include")?.Value)
                .Where(v => !string.IsNullOrEmpty(v))
                .Select(v => Path.GetFullPath(Path.Combine(projectDir, v)))
                .Where(File.Exists)
                .ToList();
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    private static bool IsInExcludedDirectory(string filePath, string projectDir)
    {
        var relativePath = Path.GetRelativePath(projectDir, filePath);
        var parts = relativePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return parts.Any(p =>
            string.Equals(p, "bin", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(p, "obj", StringComparison.OrdinalIgnoreCase));
    }
}
