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

        return new DiscoveredProject(
            Path.GetFullPath(projectFilePath),
            sourceFiles,
            projectReferences);
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
