// <copyright file="Issue4661FrozenCompilerSnapshotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4661: the C# inputs cs2gs tests take from the compiler's own sources
/// are pinned as snapshots, and the snapshots must stay honest while the live
/// file is still C#.
/// </summary>
public sealed class Issue4661FrozenCompilerSnapshotTests
{
    public static IEnumerable<object[]> ManifestEntries() =>
        FrozenCompilerSnapshots.Manifest.Select(entry => new object[] { entry.Snapshot, entry.Live });

    /// <summary>
    /// While the compiler is C#, the snapshot equals (or is contained in) the
    /// live file. After the cut-over the live file is gone by design and the
    /// snapshot is the frozen input; it must still be there and non-empty.
    /// </summary>
    /// <param name="snapshot">The snapshot path under Fixtures/FrozenCompiler.</param>
    /// <param name="live">The repository-relative live C# file.</param>
    [Theory]
    [MemberData(nameof(ManifestEntries))]
    public void Snapshot_MatchesTheLiveFile_WhileItIsCSharp(string snapshot, string live)
    {
        string text = FrozenCompilerSnapshots.Read(snapshot);
        if (SelfMigratedCompilerSource.IsGSharp)
        {
            Assert.False(string.IsNullOrWhiteSpace(text));
            return;
        }

        string livePath = TestFixtureSource.Resolve(live.Split('/'));
        string drift = FrozenCompilerSnapshots.FindDrift(text, File.ReadAllText(livePath));
        Assert.True(
            drift == null,
            $"Frozen snapshot 'Fixtures/FrozenCompiler/{snapshot}' has drifted from '{live}': {drift}. " +
            "Update the snapshot to the live text (for a whole-file snapshot, copy the file over it; " +
            "for a region snapshot, replace the text between the frozen-region markers) and re-run.");
    }

    [Fact]
    public void EverySnapshotFile_IsInTheManifest()
    {
        string directory = TestFixtureSource.Resolve("tools", "cs2gs", "Cs2Gs.Tests", "Fixtures", "FrozenCompiler");
        var onDisk = Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(directory, path).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();
        var listed = FrozenCompilerSnapshots.Manifest
            .Select(entry => entry.Snapshot)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToList();

        Assert.NotEmpty(listed);
        Assert.Equal(listed, onDisk);
    }

    [Fact]
    public void FindDrift_JudgesWholeFilesAndRegions()
    {
        string live = "a\r\nb  \r\nc\r\n";

        Assert.Null(FrozenCompilerSnapshots.FindDrift("a\nb\nc\n", live));
        Assert.NotNull(FrozenCompilerSnapshots.FindDrift("a\nb\nX\n", live));
        Assert.NotNull(FrozenCompilerSnapshots.FindDrift("a\nb\n", live));

        string region = "using X;\n" + FrozenCompilerSnapshots.RegionBegin + "\nb\nc\n" + FrozenCompilerSnapshots.RegionEnd + "\n";
        Assert.Null(FrozenCompilerSnapshots.FindDrift(region, live));
        Assert.NotNull(FrozenCompilerSnapshots.FindDrift(region.Replace("c\n", "d\n", StringComparison.Ordinal), live));
        Assert.Throws<InvalidOperationException>(
            () => FrozenCompilerSnapshots.FindDrift(FrozenCompilerSnapshots.RegionBegin + "\nb\n", live));
        Assert.Throws<InvalidOperationException>(
            () => FrozenCompilerSnapshots.FindDrift(FrozenCompilerSnapshots.RegionBegin + "\n" + FrozenCompilerSnapshots.RegionEnd, live));
    }

    /// <summary>
    /// A G# tree is read as committed, and a requested file that is not there
    /// fails instead of passing a shape guard over nothing.
    /// </summary>
    [Fact]
    public async Task SelfMigratedSource_ReadsCommittedGSharp_AndFailsOnAMissingFile()
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4661-" + Guid.NewGuid().ToString("N"));
        string parser = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax");
        string project = Path.Combine(root, "tools", "cs2gs", "Demo");
        Directory.CreateDirectory(parser);
        Directory.CreateDirectory(project);
        try
        {
            File.WriteAllText(Path.Combine(parser, "Parser.gs"), "package syntax\n");
            File.WriteAllText(Path.Combine(project, "Thing.Part.gs"), "let x = a != b\n");

            var files = await SelfMigratedCompilerSource.LoadAsync(
                root, "tools/cs2gs/Demo", preservePartialParts: true, "Thing.Part");
            Assert.Equal("let x = a != b\n", files["Thing.Part"].Text);
            Assert.Empty(files["Thing.Part"].Diagnostics);
            Assert.Contains("a!=b", SelfMigratedCompilerSource.Compact(files["Thing.Part"].Text), StringComparison.Ordinal);

            await Assert.ThrowsAsync<InvalidOperationException>(() => SelfMigratedCompilerSource.LoadAsync(
                root, "tools/cs2gs/Demo", preservePartialParts: true, "Missing"));
        }
        finally
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup must not mask the test's own result.
            }
        }
    }
}
