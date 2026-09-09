// <copyright file="TestFixtureSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Tests;

/// <summary>
/// Resolves read-only C# and project fixtures from the original source tree.
/// Native tests discover that tree above their assembly; migrated stage-4
/// tests receive it through <see cref="GsharpTestProjectRunner.SourceRootEnvironmentVariable"/>.
/// </summary>
internal static class TestFixtureSource
{
    public static string Root => GsharpTestProjectRunner.FindRepoRoot();

    public static string Resolve(params string[] relativeSegments) =>
        ResolveFromRoot(Root, relativeSegments);

    internal static string ResolveFromRoot(string root, params string[] relativeSegments)
    {
        string canonicalRoot = CanonicalRootPath.Resolve(root);
        if (!Directory.Exists(canonicalRoot))
        {
            throw new DirectoryNotFoundException(
                $"Configured source fixture root does not exist: '{canonicalRoot}'. Set " +
                $"{GsharpTestProjectRunner.SourceRootEnvironmentVariable} to the original source tree.");
        }

        string candidate = canonicalRoot;
        foreach (string segment in relativeSegments)
        {
            candidate = Path.Combine(candidate, segment);
        }

        candidate = CanonicalRootPath.Resolve(candidate);
        string rootPrefix = canonicalRoot.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        StringComparison comparison = Path.DirectorySeparatorChar == '\\'
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!string.Equals(candidate, canonicalRoot, comparison) &&
            !candidate.StartsWith(rootPrefix, comparison))
        {
            throw new InvalidOperationException(
                $"Source fixture path escapes the configured root '{canonicalRoot}': '{candidate}'.");
        }

        if (!File.Exists(candidate) && !Directory.Exists(candidate))
        {
            throw new FileNotFoundException(
                $"Source fixture was not found under '{canonicalRoot}': " +
                $"'{string.Join(Path.DirectorySeparatorChar.ToString(), relativeSegments)}'. " +
                $"Set {GsharpTestProjectRunner.SourceRootEnvironmentVariable} to the original source tree.",
                candidate);
        }

        return candidate;
    }
}
