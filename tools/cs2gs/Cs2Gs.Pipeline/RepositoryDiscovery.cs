// <copyright file="RepositoryDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>Discovers every project in a repository without corpus-specific filtering.</summary>
public static class RepositoryDiscovery
{
    /// <summary>Discovers all included C# projects under a repository root.</summary>
    /// <param name="sourceRoot">The repository root.</param>
    /// <returns>All discovered projects ordered by repository-relative path.</returns>
    public static IReadOnlyList<CorpusApp> Discover(string sourceRoot)
    {
        string root = Path.GetFullPath(sourceRoot ?? throw new ArgumentNullException(nameof(sourceRoot)));
        return RepositoryFileInventory.Enumerate(root)
            .Where(path => Path.GetExtension(path).Equals(".csproj", StringComparison.OrdinalIgnoreCase))
            .Select(path =>
            {
                string projectPath = Path.Combine(root, path);
                string projectDirectory = Path.GetDirectoryName(projectPath);
                string unsafeMarker = Path.Combine(projectDirectory, CorpusDiscovery.AllowUnsafeIlMarkerFileName);
                string stdoutGoldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
                IReadOnlyList<string> allowUnsafeIlTypes = File.Exists(unsafeMarker)
                    ? CorpusDiscovery.ReadAllowUnsafeIlTypes(unsafeMarker)
                    : Array.Empty<string>();
                return new CorpusApp(
                    path.Replace('\\', '/'),
                    projectPath,
                    ReadTargetKind(projectPath),
                    stdoutGolden: File.Exists(stdoutGoldenPath) ? stdoutGoldenPath : null,
                    allowUnsafeIl: File.Exists(unsafeMarker),
                    allowUnsafeIlTypes: allowUnsafeIlTypes,
                    relativeProjectPath: path);
            })
            .OrderBy(app => app.Id, StringComparer.Ordinal)
            .ToList();
    }

    private static TargetKind ReadTargetKind(string projectPath)
    {
        XDocument document = XDocument.Load(projectPath);
        string outputType = document
            .Descendants()
            .LastOrDefault(element => element.Name.LocalName == "OutputType")
            ?.Value;
        return string.Equals(outputType, "Exe", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(outputType, "WinExe", StringComparison.OrdinalIgnoreCase)
            ? TargetKind.Exe
            : TargetKind.Library;
    }
}
