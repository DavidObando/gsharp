// <copyright file="TestFixtureSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO

/// Resolves read-only C# and project fixtures from the original source tree.
/// Native tests discover that tree above their assembly; migrated stage-4
/// tests receive it through (cref:GsharpTestProjectRunner.SourceRootEnvironmentVariable).
internal shared class TestFixtureSource {
    prop Root string -> GsharpTestProjectRunner.FindRepoRoot()!!
    func Resolve(relativeSegments ...string) string? -> ResolveFromRoot(Root, relativeSegments)

    internal func ResolveFromRoot(root string, relativeSegments ...string) string? {
        let canonicalRoot string? = CanonicalRootPath.Resolve(root)
        if !Directory.Exists(canonicalRoot) {
            throw DirectoryNotFoundException(
                "Configured source fixture root does not exist: '$canonicalRoot'. Set " +
                    "${GsharpTestProjectRunner.SourceRootEnvironmentVariable} to the original source tree."
            )
        }
        var candidate string? = canonicalRoot
        for segment in relativeSegments {
            candidate = Path.Combine(candidate!!, segment)
        }
        candidate = CanonicalRootPath.Resolve(candidate)
        let rootPrefix = canonicalRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) +
            Path.DirectorySeparatorChar
        let comparison = if Path.DirectorySeparatorChar == '\\' {
            StringComparison.OrdinalIgnoreCase
        } else {
            StringComparison.Ordinal
        }
        if !string.Equals(candidate, canonicalRoot, comparison) && !candidate!!.StartsWith(rootPrefix, comparison) {
            throw InvalidOperationException(
                "Source fixture path escapes the configured root '$canonicalRoot': '$candidate'."
            )
        }
        if !File.Exists(candidate) && !Directory.Exists(candidate) {
            throw FileNotFoundException(
                "Source fixture was not found under '$canonicalRoot': " +
                    "'${string.Join(Path.DirectorySeparatorChar.ToString(), relativeSegments)}'. " +
                    "Set ${GsharpTestProjectRunner.SourceRootEnvironmentVariable} to the original source tree.",
                candidate
            )
        }
        return candidate
    }
}
