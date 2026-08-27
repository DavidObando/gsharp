// <copyright file="RepositoryExcludedScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #3580: the checked-in sources a targeted run's <c>--exclude</c>
/// removed from scope. The repository-mirror completeness contract (orphan
/// translation and <see cref="RepositoryMirror.ValidateCompleted"/>) applies
/// only to in-scope files — out-of-scope sources are not orphans and have no
/// mirrors to validate. The scope is each excluded project's own directory
/// plus any explicit non-wildcard <c>&lt;Compile Include&gt;</c> item
/// resolving inside the repository (shared linked sources such as
/// <c>test/Shared/*</c> live outside every project directory).
/// </summary>
internal sealed class RepositoryExcludedScope
{
    /// <summary>An empty scope: every repository file is in scope.</summary>
    internal static readonly RepositoryExcludedScope None = new(
        new List<string>(),
        new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    private readonly List<string> directories;
    private readonly HashSet<string> compileFiles;

    private RepositoryExcludedScope(List<string> directories, HashSet<string> compileFiles)
    {
        this.directories = directories;
        this.compileFiles = compileFiles;
    }

    /// <summary>
    /// Computes the excluded scope for the given projects.
    /// </summary>
    /// <param name="sourceRoot">The migrated repository's source root.</param>
    /// <param name="excludedProjectPaths">Absolute <c>.csproj</c> paths excluded from the run, or <see langword="null"/>.</param>
    /// <returns>The derived scope; <see cref="None"/> when nothing was excluded.</returns>
    internal static RepositoryExcludedScope Compute(
        string sourceRoot,
        IReadOnlyCollection<string> excludedProjectPaths)
    {
        if (excludedProjectPaths == null || excludedProjectPaths.Count == 0)
        {
            return None;
        }

        var directories = new List<string>();
        var compileFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string fullSourceRoot = Path.GetFullPath(sourceRoot);
        foreach (string projectPath in excludedProjectPaths)
        {
            string projectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectPath));
            string relativeDirectory = Path.GetRelativePath(fullSourceRoot, projectDirectory)
                .Replace('\\', '/');
            if (relativeDirectory.Length > 0
                && relativeDirectory != "."
                && !relativeDirectory.StartsWith("..", StringComparison.Ordinal))
            {
                directories.Add(relativeDirectory);
            }

            foreach (DeclaredProjectItem item in DeclaredProjectItems.Read(projectPath, "Compile"))
            {
                string include = item.Element.Attribute("Include")?.Value;
                if (string.IsNullOrEmpty(include)
                    || include.Contains("$(", StringComparison.Ordinal)
                    || include.Contains("@(", StringComparison.Ordinal)
                    || include.Contains('*', StringComparison.Ordinal))
                {
                    continue;
                }

                string fullInclude = Path.GetFullPath(Path.Combine(
                    projectDirectory,
                    include.Replace('\\', Path.DirectorySeparatorChar)
                        .Replace('/', Path.DirectorySeparatorChar)));
                string relativeInclude = Path.GetRelativePath(fullSourceRoot, fullInclude)
                    .Replace('\\', '/');
                if (!relativeInclude.StartsWith("..", StringComparison.Ordinal))
                {
                    compileFiles.Add(relativeInclude);
                }
            }
        }

        return new RepositoryExcludedScope(directories, compileFiles);
    }

    /// <summary>
    /// Returns whether a repository-relative ('/'-separated) source path is
    /// out of the run's scope.
    /// </summary>
    /// <param name="relativePath">The repository-relative source path.</param>
    /// <returns><see langword="true"/> when the file belongs to an excluded project.</returns>
    internal bool IsExcluded(string relativePath)
    {
        if (this.compileFiles.Contains(relativePath))
        {
            return true;
        }

        foreach (string directory in this.directories)
        {
            if (relativePath.StartsWith(directory + "/", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}
