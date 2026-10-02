// <copyright file="TestSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GSharp.Core.Tests;

/// <summary>
/// Locates the compiler's own source tree for the guards that read it.
/// <para>
/// Issue #4656: that tree is C# today and becomes G# when the compiler is
/// migrated, so a root is valid when it holds the parser in exactly one of the
/// two languages, and <see cref="SourceExtension"/> tells a guard which one it
/// is reading. Guards enumerate through <see cref="SourceFiles"/>, which fails
/// when a scan finds nothing: a guard that reads zero files must fail, never
/// pass.
/// </para>
/// </summary>
internal static class TestSource
{
    // Same stage-4 contract as GsharpTestProjectRunner.
    internal const string SourceRootEnvironmentVariable = "CS2GS_TEST_SOURCE_ROOT";

    internal const string CSharpExtension = ".cs";

    internal const string GSharpExtension = ".gs";

    private static readonly string ParserWithoutExtension =
        Path.Combine("src", "Core", "CodeAnalysis", "Syntax", "Parser");

    // Resolved once per test run: the environment and the tree do not change
    // under a running suite, and every guard asks.
    private static readonly Lazy<string> CachedRoot = new(() => FindRoot(
        Environment.GetEnvironmentVariable(SourceRootEnvironmentVariable),
        AppContext.BaseDirectory));

    private static readonly Lazy<string> CachedExtension = new(() => SourceExtensionOf(CachedRoot.Value));

    internal static string Root => CachedRoot.Value;

    /// <summary>
    /// Gets the extension of the compiler's sources under <see cref="Root"/>:
    /// <see cref="CSharpExtension"/> before the G# cut-over,
    /// <see cref="GSharpExtension"/> after it.
    /// </summary>
    internal static string SourceExtension => CachedExtension.Value;

    /// <summary>Gets a value indicating whether <see cref="Root"/> holds G# sources.</summary>
    internal static bool IsGSharp => SourceExtension == GSharpExtension;

    internal static string FindRoot(string? configuredRoot, string startDirectory)
    {
        if (!string.IsNullOrWhiteSpace(configuredRoot))
        {
            var root = Path.GetFullPath(configuredRoot);
            if (IsSourceRoot(root))
            {
                return root;
            }

            throw new DirectoryNotFoundException(
                $"{SourceRootEnvironmentVariable} must name the compiler's source tree (C# or G#): '{root}'.");
        }

        for (var directory = new DirectoryInfo(startDirectory); directory != null; directory = directory.Parent)
        {
            if (HasSolution(directory.FullName))
            {
                if (IsSourceRoot(directory.FullName))
                {
                    return directory.FullName;
                }

                break;
            }
        }

        throw new DirectoryNotFoundException(
            $"Could not find the compiler's source tree. Set {SourceRootEnvironmentVariable}.");
    }

    /// <summary>
    /// The language of the tree at <paramref name="root"/>, decided by which
    /// parser file it holds.
    /// </summary>
    /// <param name="root">A source root.</param>
    /// <returns>The source extension, including the dot.</returns>
    internal static string SourceExtensionOf(string root)
    {
        bool csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + CSharpExtension));
        bool gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + GSharpExtension));
        if (csharp == gsharp)
        {
            throw new DirectoryNotFoundException(
                $"'{root}' must hold the parser in exactly one language (Parser.cs or Parser.gs).");
        }

        return csharp ? CSharpExtension : GSharpExtension;
    }

    /// <summary>
    /// The absolute path of one compiler source file, given its
    /// repository-relative path WITHOUT an extension.
    /// </summary>
    /// <param name="relativePathWithoutExtension">For example <c>src/Core/CodeAnalysis/Emit/SlotPlanner</c>.</param>
    /// <returns>The path in the tree's language.</returns>
    internal static string SourcePath(string relativePathWithoutExtension) =>
        Path.Combine(Root, relativePathWithoutExtension.Replace('/', Path.DirectorySeparatorChar) + SourceExtension);

    /// <summary>
    /// Every compiler source file under the given repository-relative
    /// directories, in the tree's language, skipping build output.
    /// </summary>
    /// <param name="option">Whether to recurse.</param>
    /// <param name="relativeDirectories">Repository-relative directories, each of which must exist.</param>
    /// <returns>The absolute paths, sorted.</returns>
    /// <exception cref="DirectoryNotFoundException">A directory is missing.</exception>
    /// <exception cref="InvalidOperationException">The scan found no files.</exception>
    internal static IReadOnlyList<string> SourceFiles(SearchOption option, params string[] relativeDirectories) =>
        SourceFilesMatching("*", option, relativeDirectories);

    /// <summary>
    /// As <see cref="SourceFiles"/>, restricted to file names matching
    /// <paramref name="stemPattern"/> (a wildcard pattern without extension).
    /// </summary>
    /// <param name="stemPattern">For example <c>Parser*</c>.</param>
    /// <param name="option">Whether to recurse.</param>
    /// <param name="relativeDirectories">Repository-relative directories, each of which must exist.</param>
    /// <returns>The absolute paths, sorted.</returns>
    internal static IReadOnlyList<string> SourceFilesMatching(
        string stemPattern, SearchOption option, params string[] relativeDirectories)
    {
        string root = Root;
        string extension = SourceExtension;
        // A set: overlapping directories must not count a file twice.
        var files = new HashSet<string>(StringComparer.Ordinal);
        foreach (string relative in relativeDirectories)
        {
            string directory = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!Directory.Exists(directory))
            {
                throw new DirectoryNotFoundException(
                    $"Source guard directory '{relative}' does not exist under '{root}'. A guard over a moved " +
                    "directory must be updated, not allowed to scan nothing.");
            }

            files.UnionWith(Directory.EnumerateFiles(directory, stemPattern + extension, option)
                .Select(Path.GetFullPath)
                .Where(path => !IsBuildOutput(root, path)));
        }

        if (files.Count == 0)
        {
            throw new InvalidOperationException(
                $"Source guard scanned zero '{stemPattern}{extension}' files under {string.Join(", ", relativeDirectories)}; " +
                "a guard that reads nothing proves nothing (#4656).");
        }

        return files.OrderBy(path => path, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// The repository-relative path of a source file without its extension, so
    /// allow-lists and inventories name a file the same way in both languages.
    /// </summary>
    /// <param name="absolutePath">A path under <see cref="Root"/>.</param>
    /// <returns>For example <c>src/Core/CodeAnalysis/Lowering/Lowerer</c>.</returns>
    internal static string RelativeStem(string absolutePath)
    {
        string relative = Path.GetRelativePath(Root, absolutePath).Replace('\\', '/');
        return relative.Substring(0, relative.Length - Path.GetExtension(relative).Length);
    }

    /// <summary>
    /// Issue #4656: the C# text of a fixture under <c>test/Core.Tests/Fixtures</c>
    /// that a test compiles with Roslyn as a C#-authored reference. The
    /// migration translates those fixtures to G# with the rest of the project,
    /// so each one used this way is also kept verbatim as
    /// <c>test/Core.Tests/TestData/CSharpFixtureSources/&lt;fixture file name&gt;.txt</c>,
    /// the full file name including <c>.cs</c> plus <c>.txt</c> (for example
    /// <c>InterpolatedStringHandlerFixtures.cs.txt</c>).
    /// While the live C# file exists it is returned and must equal the
    /// snapshot (no drift); after the cut-over the snapshot is returned.
    /// </summary>
    /// <param name="fileName">For example <c>InterpolatedStringHandlerFixtures.cs</c>.</param>
    /// <returns>The fixture's C# source.</returns>
    internal static string CSharpFixtureSource(string fileName) => CSharpFixtureSource(Root, fileName);

    /// <summary>As <see cref="CSharpFixtureSource(string)"/>, under an explicit source root.</summary>
    /// <param name="root">The source root.</param>
    /// <param name="fileName">The fixture file name.</param>
    /// <returns>The fixture's C# source.</returns>
    internal static string CSharpFixtureSource(string root, string fileName)
    {
        string snapshotPath = Path.Combine(root, "test", "Core.Tests", "TestData", "CSharpFixtureSources", fileName + ".txt");
        if (!File.Exists(snapshotPath))
        {
            throw new FileNotFoundException("The C# fixture snapshot is missing.", snapshotPath);
        }

        string snapshot = File.ReadAllText(snapshotPath);
        string livePath = Path.Combine(root, "test", "Core.Tests", "Fixtures", fileName);
        if (File.Exists(livePath))
        {
            string live = File.ReadAllText(livePath);
            if (!string.Equals(live, snapshot, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"{snapshotPath} is out of date with {livePath}. Copy the fixture over the snapshot: the " +
                    "snapshot is what this test compiles once the fixtures are G#.");
            }

            return live;
        }

        if (!snapshot.Contains("namespace GSharp.Core.Tests.Fixtures", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"{snapshotPath} does not hold the expected C# fixture.");
        }

        return snapshot;
    }

    // Judged on the path BELOW the root: the root itself may sit under a bin/
    // (a test's temporary tree inside its output directory, for one).
    private static bool IsBuildOutput(string root, string path) =>
        Path.GetRelativePath(root, path)
            .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            .Any(segment => string.Equals(segment, "obj", StringComparison.OrdinalIgnoreCase)
                || string.Equals(segment, "bin", StringComparison.OrdinalIgnoreCase));

    private static bool HasSolution(string directory) =>
        File.Exists(Path.Combine(directory, "GSharp.sln")) || File.Exists(Path.Combine(directory, "GSharp.slnx"));

    private static bool IsSourceRoot(string root)
    {
        if (!HasSolution(root))
        {
            return false;
        }

        bool csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + CSharpExtension));
        bool gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + GSharpExtension));
        return csharp != gsharp;
    }
}
