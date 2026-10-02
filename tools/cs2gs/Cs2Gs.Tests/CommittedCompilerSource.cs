// <copyright file="CommittedCompilerSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4656: the compiler's committed sources are C# until the G# cut-over
/// and G# after it. The self-migration inventories translate the C# today;
/// once the committed tree is G# there is nothing to translate, and the same
/// "no retired synthesized names" rule is checked as a counter over the
/// committed <c>.gs</c> files instead.
/// </summary>
internal static class CommittedCompilerSource
{
    private static readonly string ParserWithoutExtension =
        Path.Combine("src", "Core", "CodeAnalysis", "Syntax", "Parser");

    /// <summary>
    /// Whether the compiler sources under <paramref name="root"/> are G#.
    /// Exactly one of <c>Parser.cs</c> and <c>Parser.gs</c> must exist; a tree
    /// with both or neither cannot say which language its inventories should read.
    /// </summary>
    /// <param name="root">The source root.</param>
    /// <returns><see langword="true"/> for a G# tree.</returns>
    internal static bool IsGSharp(string root)
    {
        bool csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + ".cs"));
        bool gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + ".gs"));
        if (csharp == gsharp)
        {
            throw new InvalidOperationException(
                $"'{root}' must hold the compiler parser in exactly one language (Parser.cs or Parser.gs).");
        }

        return gsharp;
    }

    /// <summary>
    /// The committed <c>.gs</c> files under the given repository-relative
    /// directories, skipping build output. Fails on a missing directory or an
    /// empty result: an inventory over nothing would report zero and pass.
    /// </summary>
    /// <param name="root">The source root.</param>
    /// <param name="relativeDirectories">Repository-relative directories.</param>
    /// <returns>The file paths, sorted.</returns>
    internal static IReadOnlyList<string> GSharpFiles(string root, params string[] relativeDirectories)
    {
        // A set: overlapping directories ("src" and "src/Core") must not count
        // a file twice.
        // Path case is folded only on Windows; elsewhere (including
        // case-sensitive macOS volumes) two spellings may be two files.
        var files = new HashSet<string>(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (string relative in relativeDirectories)
        {
            string directory = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(directory))
            {
                throw new DirectoryNotFoundException($"Inventory directory '{relative}' does not exist under '{root}'.");
            }

            files.UnionWith(Directory.EnumerateFiles(directory, "*.gs", SearchOption.AllDirectories)
                .Select(Path.GetFullPath)
                .Where(path => !IsBuildOutput(root, path)));
        }

        if (files.Count == 0)
        {
            throw new InvalidOperationException(
                $"The inventory found no committed .gs files under {string.Join(", ", relativeDirectories)}; " +
                "a count over nothing proves nothing (#4656).");
        }

        return files.OrderBy(path => path, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// Whether <paramref name="path"/> lies in build output (an <c>obj</c> or
    /// <c>bin</c> segment) BELOW <paramref name="root"/>; the root itself may
    /// sit under a bin/ directory.
    /// </summary>
    /// <param name="root">The scanned root.</param>
    /// <param name="path">A file under it.</param>
    /// <returns><see langword="true"/> for build output.</returns>
    internal static bool IsBuildOutput(string root, string path) =>
        Path.GetRelativePath(root, path)
            .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Any(segment => string.Equals(segment, "obj", StringComparison.OrdinalIgnoreCase)
                || string.Equals(segment, "bin", StringComparison.OrdinalIgnoreCase));
}
