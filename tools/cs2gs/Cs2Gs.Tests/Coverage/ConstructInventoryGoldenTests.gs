// <copyright file="ConstructInventoryGoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Coverage

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Cs2Gs.Pipeline
import Cs2Gs.Translator.Coverage
import GSharp.Tests
import Xunit
import Cs2Gs.Tests

/// The construct-inventory contract (ADR-0138): the Roslyn surface snapshot
/// matches its golden (a Roslyn bump that adds node kinds fails here until the
/// new constructs are classified), the checked-in inventory covers exactly that
/// surface with valid rows, the generated docs matrix is in sync, and the
/// unclassified/fixture ratchets never regress.
open class ConstructInventoryGoldenTests {
    @Fact
    func RoslynSurface_MatchesGolden() {
        let generated = RoslynSurface.BuildSnapshot()
        let goldenPath = Path.Combine(
            RepoRoot(),
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Coverage",
            "roslyn-surface.golden.txt"
        )
        GoldenFile.AssertMatches(
            goldenPath,
            generated,
            "Roslyn surface changed. Classify the delta in " +
                "${ConstructInventory.RepoRelativePath} with `cs2gs coverage --write`."
        )
    }

    @Fact
    func Inventory_IsValid_AndCoversTheSurface() {
        let inventory = LoadInventory()
        let errors = inventory.Validate(TestFixtureSource.Root)
        Assert.True(errors.Count == 0, "construct inventory violations:\n" + string.Join("\n", errors))
    }

    @Fact
    func Inventory_IsCanonicallyFormatted() {
        let path = InventoryPath()
        let inventory = ConstructInventory.Load(path)
        let canonical = inventory.ToJson()
        let onDisk = File.ReadAllText(path).ReplaceLineEndings(Environment.NewLine)
        Assert.True(
            string.Equals(canonical, onDisk, StringComparison.Ordinal),
            "${ConstructInventory.RepoRelativePath} is not canonically formatted/sorted; run `cs2gs coverage --write`."
        )
    }

    @Fact
    func MatrixDocument_IsInSync() {
        let inventory = LoadInventory()
        let generated = inventory.BuildMatrixMarkdown()
        let docPath = Path.Combine(RepoRoot(), "docs", "cs2gs-coverage-matrix.md")
        GoldenFile.AssertMatches(
            docPath,
            generated,
            "`docs/cs2gs-coverage-matrix.md` drifted from the inventory; run `cs2gs coverage --write`."
        )
    }

    /// Guards against #2020: the generated matrix's "| Status | Count |" header
    /// table and each "## Status (N)" section heading must always equal the
    /// number of rows actually printed under that status — computed from the
    /// SAME markdown text BuildMatrixMarkdown produced, not from the inventory
    /// a second time. A regression here (e.g. a duplicate-counting bug, or a
    /// header computed from a different collection than the rows) would
    /// otherwise only surface as an opaque "drifted, run coverage --write"
    /// failure in MatrixDocument_IsInSync.
    @Fact
    func MatrixDocument_HeaderCountsMatchRowCounts() {
        let inventory = LoadInventory()
        let lines = inventory.BuildMatrixMarkdown().Split(Environment.NewLine)
        let summaryCounts = Dictionary[string, int32](StringComparer.Ordinal)
        let sectionHeadingCounts = Dictionary[string, int32](StringComparer.Ordinal)
        let actualRowCounts = Dictionary[string, int32](StringComparer.Ordinal)
        var currentSection string? = nil
        for line in lines {
            if line.StartsWith("## ", StringComparison.Ordinal) {
                // "## Translated (229)"
                let open_ = line.LastIndexOf('(')
                let close = line.LastIndexOf(')')
                currentSection = line.Substring(3, open_ - 3).Trim()
                sectionHeadingCounts[currentSection] = int32.Parse(line.Substring(open_ + 1, close - open_ - 1))
                continue
            }
            let isDataRow = line.StartsWith("| ", StringComparison.Ordinal) && !line.StartsWith(
                "| Kind ",
                StringComparison.Ordinal
            ) &&
                !line.StartsWith("| --- ", StringComparison.Ordinal) && !line.StartsWith(
                "| Status ",
                StringComparison.Ordinal
            )
            if !isDataRow {
                continue
            }
            let cells = line.Trim('|').Split('|').Select((c string) -> c.Trim()).ToArray()
            if currentSection == nil && cells.Length == 2 && int32.TryParse(cells[1], out var summaryCount) {
                // The "| Status | Count |" summary table, before any "## " section.
                summaryCounts[cells[0]] = summaryCount
            } else if currentSection != nil {
                actualRowCounts[currentSection] = actualRowCounts.GetValueOrDefault(currentSection) + 1
            }
        }
        for status in Enum.GetValues[ConstructStatus]() {
            let name = status.ToString()
            let actual = actualRowCounts.GetValueOrDefault(name)
            Assert.True(
                summaryCounts.TryGetValue(name, out var summary),
                "summary table is missing a row for status '$name'."
            )
            Assert.True(
                summary == actual,
                "'$name' summary count ($summary) does not match the actual printed row count ($actual)."
            )
            if actual > 0 {
                Assert.True(
                    sectionHeadingCounts.TryGetValue(name, out var heading),
                    "'## $name' section heading is missing."
                )
                Assert.True(
                    heading == actual,
                    "'## $name ($heading)' heading does not match its own printed row count ($actual)."
                )
            }
        }
    }

    @Fact
    func UnclassifiedRatchet_DoesNotRegress() {
        let inventory = LoadInventory()
        let unclassified = inventory.Entries.Count((e ConstructEntry) -> e.Status == ConstructStatus.Unclassified)
        Assert.True(
            unclassified <= MaxUnclassified,
            "$unclassified unclassified constructs exceed the ratchet ($MaxUnclassified). " +
                "Classify the new kinds; never raise the ratchet."
        )
    }

    @Fact
    func FixtureRatchet_DoesNotRegress() {
        let inventory = LoadInventory()
        let withoutFixture = inventory.Entries.Count(
            (e ConstructEntry) -> (e.Status is ConstructStatus.Translated or ConstructStatus.Lowered) &&
                string.IsNullOrEmpty(e.Fixture)
        )
        Assert.True(
            withoutFixture <= MaxTranslatedWithoutFixture,
            "$withoutFixture translated/lowered constructs lack a fixture, exceeding the ratchet " +
                "($MaxTranslatedWithoutFixture). Add grid fixtures; never raise the ratchet."
        )
    }

    shared {
        /// Ratchet: the number of inventory rows still Unclassified. Lower it as
        /// classification waves land; never raise it. Target: 0.
        private const MaxUnclassified int32 = 0

        /// Ratchet: translated/lowered rows without a fixture yet. Lower it as the
        /// grid corpus (M4) lands; never raise it. Target: 0.
        private const MaxTranslatedWithoutFixture int32 = 51

        private func LoadInventory() ConstructInventory {
            let path = InventoryPath()
            Assert.True(File.Exists(path), "missing inventory at $path; run `cs2gs coverage --write`.")
            return ConstructInventory.Load(path)
        }

        private func InventoryPath() string -> Path.Combine(
            RepoRoot(),
            ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar)
        )

        private func RepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(ConstructInventoryGoldenTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            throw InvalidOperationException("GSharp.sln or GSharp.slnx not found above the test assembly.")
        }
    }
}
