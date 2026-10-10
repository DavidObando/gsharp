// <copyright file="Issue4861RepositoryRootMarkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4861: the repository root used to be found by probing the literal
/// file name <c>GSharp.sln</c> from about 100 places, so the cut-over (which
/// keeps only the generated <c>GSharp.slnx</c>) had to rewrite them all by
/// text. There is now one rule, <see cref="RepositoryRootMarker"/>, accepting
/// either spelling. These tests fail if the rule stops accepting the
/// <c>.slnx</c>, if the test-side copy drifts from it, or if a new literal
/// literal appears.
/// </summary>
public sealed class Issue4861RepositoryRootMarkerTests : IDisposable
{
    private readonly string root = Path.Combine(
        Path.GetTempPath(),
        "gs4861-" + Guid.NewGuid().ToString("N"));

    public Issue4861RepositoryRootMarkerTests()
    {
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        Directory.Delete(this.root, recursive: true);
    }

    [Theory]
    [InlineData("GSharp.sln")]
    [InlineData("GSharp.slnx")]
    public void EitherSolutionSpelling_AnchorsTheRoot(string solution)
    {
        File.WriteAllText(Path.Combine(this.root, solution), string.Empty);

        Assert.True(RepositoryRootMarker.IsRoot(this.root));
    }

    [Fact]
    public void NoSolution_IsNotARoot()
    {
        File.WriteAllText(Path.Combine(this.root, "Other.slnx"), string.Empty);

        Assert.False(RepositoryRootMarker.IsRoot(this.root));
    }

    [Theory]
    [InlineData("GSharp.sln")]
    [InlineData("GSharp.slnx")]
    public void FindRepoRoot_WalksUpToEitherSolutionSpelling(string solution)
    {
        File.WriteAllText(Path.Combine(this.root, solution), string.Empty);
        File.WriteAllText(Path.Combine(this.root, "nuget.config"), "<configuration />");
        string nested = Path.Combine(this.root, "out", "bin", "Release", "Cs2Gs.Cli");
        Directory.CreateDirectory(nested);

        Assert.Equal(this.root, GsharpTestProjectRunner.FindRepoRootAbove(nested));
    }

    [Fact]
    public void FindRepoRoot_RequiresNuGetConfigBesideTheSolution()
    {
        File.WriteAllText(Path.Combine(this.root, "GSharp.slnx"), string.Empty);

        Assert.Null(GsharpTestProjectRunner.FindRepoRootAbove(this.root));
    }

    /// <summary>
    /// The test projects carry their own copy of the rule
    /// (<c>test/Shared/RepositoryRootMarker.cs</c>) because they cannot
    /// reference cs2gs. It must name exactly the spellings the product rule does.
    /// </summary>
    [Fact]
    public void SharedTestCopy_NamesTheSameSolutionFiles()
    {
        string repo = LocateRepoRoot();
        string shared = SourceOf(Path.Combine(repo, "test", "Shared", "RepositoryRootMarker"));
        var spellings = Regex.Matches(shared, "\"(GSharp\\.slnx?)\"").Select(m => m.Groups[1].Value)
            .OrderBy(s => s, StringComparer.Ordinal).ToArray();

        Assert.Equal(
            RepositoryRootMarker.SolutionFileNames.OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            spellings);
    }

    /// <summary>
    /// No source file may spell the solution name as a string literal, because
    /// any probe built from one (<c>File.Exists</c>, <c>FileInfo.Exists</c>,
    /// <c>Path.Join</c>, <c>Directory.GetFiles</c>, ...) would anchor the root
    /// on a single spelling again. Root discovery goes through
    /// <see cref="RepositoryRootMarker"/>. The files below legitimately name the
    /// file: the two marker implementations, this test, and tests that write a
    /// fixture solution into a scratch directory.
    /// </summary>
    [Fact]
    public void NoSourceFileSpellsALiteralSolutionName()
    {
        string repo = LocateRepoRoot();
        var literal = new Regex("\"GSharp\\.slnx?\"");
        var allowed = new[]
        {
            "RepositoryRootMarker.cs", "RepositoryRootMarker.gs",
            "Issue4861RepositoryRootMarkerTests.cs", "Issue4861RepositoryRootMarkerTests.gs",
            "TestSourceTests.cs", "TestSourceTests.gs",
            "Adr0151IfLetExpressionTranslationTests.cs", "Adr0151IfLetExpressionTranslationTests.gs",
        };
        var offenders = new[] { "test", "tools", "src" }
            .SelectMany(d => Directory.EnumerateFiles(Path.Combine(repo, d), "*.*", SearchOption.AllDirectories))
            .Where(f => (f.EndsWith(".cs", StringComparison.Ordinal) || f.EndsWith(".gs", StringComparison.Ordinal))
                && !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar))
            .Where(f => !allowed.Contains(Path.GetFileName(f)))
            .Where(f => literal.IsMatch(File.ReadAllText(f)))
            .Select(f => Path.GetRelativePath(repo, f))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToArray();

        Assert.Empty(offenders);
    }

    private static string SourceOf(string withoutExtension)
    {
        string cs = withoutExtension + ".cs";
        return File.ReadAllText(File.Exists(cs) ? cs : withoutExtension + ".gs");
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (RepositoryRootMarker.IsRoot(dir.FullName))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("repository root not found from " + AppContext.BaseDirectory);
    }
}
