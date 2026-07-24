// <copyright file="RepositoryFileInventory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>Enumerates source-controlled and non-ignored repository files.</summary>
internal static class RepositoryFileInventory
{
    internal static IReadOnlyList<string> Enumerate(string sourceRoot)
    {
        string root = Path.GetFullPath(sourceRoot);
        ProcessRunResult prefixResult = ProcessRunner.Run(
            "git",
            new[] { "-C", root, "rev-parse", "--show-prefix" },
            root,
            TimeSpan.FromSeconds(30));
        if (prefixResult.ExitCode == 0)
        {
            ProcessRunResult filesResult = ProcessRunner.Run(
                "git",
                new[] { "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "." },
                root,
                TimeSpan.FromSeconds(30));
            if (filesResult.ExitCode == 0)
            {
                return (filesResult.Output ?? string.Empty)
                    .Split('\0', StringSplitOptions.RemoveEmptyEntries)
                    .Select(path => path.Replace('\\', '/'))
                    .Where(path => path.Length > 0 && !HasExcludedDirectory(path))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(path => path, StringComparer.Ordinal)
                    .ToList();
            }
        }

        return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(root, path))
            .Where(path => !HasExcludedDirectory(path))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();
    }

    internal static bool HasExcludedDirectory(string relativePath)
    {
        string[] segments = relativePath.Split(
            new[] { '/', '\\' },
            StringSplitOptions.RemoveEmptyEntries);
        return segments.Any(segment =>
            segment.Equals(".git", StringComparison.OrdinalIgnoreCase) ||
            segment.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
            segment.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
            segment.Equals("TestResults", StringComparison.OrdinalIgnoreCase));
    }
}
