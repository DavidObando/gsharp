// <copyright file="ConstructInventoryGoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Translator.Coverage;
using Xunit;

namespace Cs2Gs.Tests.Coverage;

/// <summary>
/// The construct-inventory contract (ADR-0138): the Roslyn surface snapshot
/// matches its golden (a Roslyn bump that adds node kinds fails here until the
/// new constructs are classified), the checked-in inventory covers exactly that
/// surface with valid rows, the generated docs matrix is in sync, and the
/// unclassified/fixture ratchets never regress.
/// </summary>
public class ConstructInventoryGoldenTests
{
    /// <summary>
    /// Ratchet: the number of inventory rows still Unclassified. Lower it as
    /// classification waves land; never raise it. Target: 0.
    /// </summary>
    private const int MaxUnclassified = 0;

    /// <summary>
    /// Ratchet: translated/lowered rows without a fixture yet. Lower it as the
    /// grid corpus (M4) lands; never raise it. Target: 0.
    /// </summary>
    private const int MaxTranslatedWithoutFixture = 58;

    [Fact]
    public void RoslynSurface_MatchesGolden()
    {
        string generated = RoslynSurface.BuildSnapshot();
        string goldenPath = Path.Combine(RepoRoot(), "tools", "cs2gs", "Cs2Gs.Tests", "Coverage", "roslyn-surface.golden.txt");
        Assert.True(File.Exists(goldenPath), $"missing golden at {goldenPath}");
        string golden = File.ReadAllText(goldenPath).Replace("\r\n", "\n");

        if (!string.Equals(generated, golden, StringComparison.Ordinal))
        {
            string actualPath = goldenPath + ".actual";
            File.WriteAllText(actualPath, generated);
            Assert.Fail(
                "Roslyn-surface snapshot drifted (a Roslyn upgrade added/removed node kinds?).\n" +
                $"Classify the delta in {ConstructInventory.RepoRelativePath} (run `cs2gs coverage --write`),\n" +
                $"then update the golden. Wrote regenerated snapshot to `{actualPath}`.");
        }
    }

    [Fact]
    public void Inventory_IsValid_AndCoversTheSurface()
    {
        ConstructInventory inventory = LoadInventory();
        IReadOnlyList<string> errors = inventory.Validate(RepoRoot());
        Assert.True(errors.Count == 0, "construct inventory violations:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Inventory_IsCanonicallyFormatted()
    {
        string path = InventoryPath();
        ConstructInventory inventory = ConstructInventory.Load(path);
        string canonical = inventory.ToJson();
        string onDisk = File.ReadAllText(path).Replace("\r\n", "\n");
        Assert.True(
            string.Equals(canonical, onDisk, StringComparison.Ordinal),
            $"{ConstructInventory.RepoRelativePath} is not canonically formatted/sorted; run `cs2gs coverage --write`.");
    }

    [Fact]
    public void MatrixDocument_IsInSync()
    {
        ConstructInventory inventory = LoadInventory();
        string generated = inventory.BuildMatrixMarkdown();
        string docPath = Path.Combine(RepoRoot(), "docs", "cs2gs-coverage-matrix.md");
        Assert.True(File.Exists(docPath), $"missing generated matrix at {docPath}; run `cs2gs coverage --write`.");
        string onDisk = File.ReadAllText(docPath).Replace("\r\n", "\n");

        if (!string.Equals(generated, onDisk, StringComparison.Ordinal))
        {
            File.WriteAllText(docPath + ".actual", generated);
            Assert.Fail(
                $"docs/cs2gs-coverage-matrix.md drifted from the inventory; run `cs2gs coverage --write`.\n" +
                $"Wrote regenerated matrix to `{docPath}.actual`.");
        }
    }

    [Fact]
    public void UnclassifiedRatchet_DoesNotRegress()
    {
        ConstructInventory inventory = LoadInventory();
        int unclassified = inventory.Entries.Count(e => e.Status == ConstructStatus.Unclassified);
        Assert.True(
            unclassified <= MaxUnclassified,
            $"{unclassified} unclassified constructs exceed the ratchet ({MaxUnclassified}). " +
            "Classify the new kinds; never raise the ratchet.");
    }

    [Fact]
    public void FixtureRatchet_DoesNotRegress()
    {
        ConstructInventory inventory = LoadInventory();
        int withoutFixture = inventory.Entries.Count(e =>
            e.Status is ConstructStatus.Translated or ConstructStatus.Lowered
            && string.IsNullOrEmpty(e.Fixture));
        Assert.True(
            withoutFixture <= MaxTranslatedWithoutFixture,
            $"{withoutFixture} translated/lowered constructs lack a fixture, exceeding the ratchet " +
            $"({MaxTranslatedWithoutFixture}). Add grid fixtures; never raise the ratchet.");
    }

    private static ConstructInventory LoadInventory()
    {
        string path = InventoryPath();
        Assert.True(File.Exists(path), $"missing inventory at {path}; run `cs2gs coverage --write`.");
        return ConstructInventory.Load(path);
    }

    private static string InventoryPath() =>
        Path.Combine(RepoRoot(), ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar));

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(ConstructInventoryGoldenTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("GSharp.sln not found above the test assembly.");
    }
}
