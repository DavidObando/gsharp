// <copyright file="RepositoryFileInventory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Enumerates source-controlled and non-ignored repository files.
internal shared class RepositoryFileInventory {
    internal func Enumerate(sourceRoot string?) IReadOnlyList[string] {
        let root = Path.GetFullPath(sourceRoot!!)
        let prefixResult = ProcessRunner.Run(
            "git",
            []string{"-C", root, "rev-parse", "--show-prefix"},
            root,
            TimeSpan.FromSeconds(30)
        )
        if prefixResult.ExitCode == 0 {
            let filesResult = ProcessRunner.Run(
                "git",
                []string{"-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."},
                root,
                TimeSpan.FromSeconds(30)
            )
            if filesResult.ExitCode == 0 {
                return (filesResult.Output ?? string.Empty)
                    .Split('\u0000', StringSplitOptions.RemoveEmptyEntries)
                    .Select((path string) -> path.Replace('\\', '/'))
                    .Where((path string) -> path.Length > 0 && !HasExcludedDirectory(path))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy((path string) -> path, StringComparer.Ordinal)
                    .ToList()
            }
        }
        return Directory
            .EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select((path string) -> Path.GetRelativePath(root, path))
            .Where((path string) -> !HasExcludedDirectory(path))
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToList()
    }

    internal func HasExcludedDirectory(relativePath string) bool {
        let segments = relativePath.Split([]char{'/', '\\'}, StringSplitOptions.RemoveEmptyEntries)
        // Issue #4852: the top-level `out/` directory is the repository's build
        // output root (bin/obj/nupkgs/scratch tools). Whatever is tracked under
        // it (out/scratch/...) is a stray output, never a source or an app.
        return IsBuildOutputPath(relativePath) ||
            (segments.Length > 1 && segments[0].Equals("out", StringComparison.OrdinalIgnoreCase)) ||
            segments
            .Any(
            (segment string) -> segment.Equals(".git", StringComparison.OrdinalIgnoreCase) || segment.Equals(
                "TestResults",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    internal func IsBuildOutputPath(relativePath string) bool -> relativePath.Split(
        []char{'/', '\\'},
        StringSplitOptions.RemoveEmptyEntries
    )
        .Any(
        (segment string) -> segment.Equals("bin", StringComparison.OrdinalIgnoreCase) || segment.Equals(
            "obj",
            StringComparison.OrdinalIgnoreCase
        )
    )
}
