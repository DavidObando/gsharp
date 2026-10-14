// <copyright file="RepositoryDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Discovers every project in a repository without corpus-specific filtering.
shared class RepositoryDiscovery {
    /// Discovers all included C# projects under a repository root.
    /// @param sourceRoot The repository root.
    /// @returns All discovered projects ordered by repository-relative path.
    func Discover(sourceRoot string) IReadOnlyList[CorpusApp] {
        let root = Path.GetFullPath(sourceRoot ?? throw ArgumentNullException("sourceRoot"))
        return RepositoryFileInventory
            .Enumerate(root)
            .Where((path string) -> Path.GetExtension(path).Equals(".csproj", StringComparison.OrdinalIgnoreCase))
            .Select(
            (path string) -> {
                let projectPath = Path.Combine(root, path)
                let projectDirectory string? = Path.GetDirectoryName(projectPath)
                let unsafeMarker = Path.Combine(projectDirectory!!, CorpusDiscovery.AllowUnsafeIlMarkerFileName)
                let stdoutGoldenPath = Path.Combine(projectDirectory!!, "baseline.stdout.golden")
                let allowUnsafeIlTypes = if File.Exists(unsafeMarker) {
                    CorpusDiscovery.ReadAllowUnsafeIlTypes(unsafeMarker)
                } else {
                    cast[IReadOnlyList[string]](Array.Empty[string]())
                }
                return CorpusApp(
                    path.Replace('\\', '/'),
                    projectPath,
                    CorpusDiscovery.ReadTargetKind(projectPath),
                    stdoutGolden: if File.Exists(stdoutGoldenPath) {
                        stdoutGoldenPath
                    } else {
                        default(string?)
                    },
                    allowUnsafeIl: File.Exists(unsafeMarker),
                    allowUnsafeIlTypes: allowUnsafeIlTypes,
                    relativeProjectPath: path
                )
            }
        )
            .OrderBy((app CorpusApp) -> app.Id, StringComparer.Ordinal)
            .ToList()
    }
}
