// <copyright file="Issue4661FrozenCompilerSnapshotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #4661: the C# inputs cs2gs tests take from the compiler's own sources
/// are pinned as snapshots, and the snapshots must stay honest while the live
/// file is still C#.
class Issue4661FrozenCompilerSnapshotTests {
    /// While the compiler is C#, the snapshot equals the live file (or the live
    /// region it mirrors), compared with the shared `GoldenFile` workflow:
    /// first differing line, a `.actual` file, and
    /// `GSHARP_UPDATE_GOLDENS=1` to refresh the snapshot. After the
    /// cut-over the live file is gone by design and the snapshot is the frozen
    /// input; it must still be there and non-empty.
    /// @param snapshot The snapshot path under Fixtures/FrozenCompiler.
    /// @param live The repository-relative live C# file.
    /// @param region Whether the snapshot mirrors only a region of the live file.
    @Theory
    @MemberData("ManifestEntries")
    func Snapshot_MatchesTheLiveFile_WhileItIsCSharp(snapshot string, live string, region bool) {
        let text = FrozenCompilerSnapshots.Read(snapshot)
        if SelfMigratedCompilerSource.IsGSharp {
            Assert.False(string.IsNullOrWhiteSpace(text))
            return
        }
        let livePath string? = TestFixtureSource.Resolve(live.Split('/'))
        GoldenFile.AssertMatches(
            FrozenCompilerSnapshots.Path(snapshot),
            FrozenCompilerSnapshots.LiveText(text, File.ReadAllText(livePath!!), region),
            "The frozen snapshot has drifted from '$live'."
        )
    }

    @Fact
    func EverySnapshotFile_IsInTheManifest() {
        let directory string? = TestFixtureSource.Resolve("tools", "cs2gs", "Cs2Gs.Tests", "Fixtures", "FrozenCompiler")
        let onDisk = Directory
            .EnumerateFiles(directory!!, "*", SearchOption.AllDirectories)
            .Where((path string) -> !path.EndsWith(".actual", StringComparison.Ordinal))
            .Select((path string) -> Path.GetRelativePath(directory!!, path).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToList()
        let listed = FrozenCompilerSnapshots
            .Manifest
            .Select((entry(Snapshot string, Live string, Region bool)) -> entry.Snapshot)
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToList()
        Assert.NotEmpty(listed)
        Assert.Equal(listed, onDisk)
    }

    @Fact
    func LiveText_SelectsTheWholeFileOrTheMirroredRegion() {
        let live = "a\r\nb\r\nc\r\nd\r\n"
        Assert.Equal(`a
b
c
d
`, FrozenCompilerSnapshots.LiveText("anything", live, region: false))
        // A region is the tail of the live file from the snapshot's first line, so
        // lines added or removed inside it are picked up whole.
        Assert.Equal(`b
c
d
`, FrozenCompilerSnapshots.LiveText(`b
c
`, live, region: true))
        Assert.Equal(`b
c
d
`, FrozenCompilerSnapshots.LiveText(`b
X
Y
Z
W
`, live, region: true))
        Assert.Throws[InvalidOperationException](
            func () object? {
                return FrozenCompilerSnapshots.LiveText("zzz\n", live, region: true)
            }
        )
    }

    /// A G# tree is read as committed, and a requested file that is not there
    /// fails instead of passing a shape guard over nothing.
    @Fact
    async func SelfMigratedSource_ReadsCommittedGSharp_AndFailsOnAMissingFile() {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4661-" + Guid.NewGuid().ToString("N"))
        let parser = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax")
        let project = Path.Combine(root, "tools", "cs2gs", "Demo")
        Directory.CreateDirectory(parser)
        Directory.CreateDirectory(project)
        try {
            File.WriteAllText(Path.Combine(parser, "Parser.gs"), "package syntax\n")
            File.WriteAllText(Path.Combine(project, "Thing.Part.gs"), "let x = a != b\n")
            let files = await SelfMigratedCompilerSource.LoadAsync(
                root,
                "tools/cs2gs/Demo",
                preservePartialParts: true,
                "Thing.Part"
            )
            Assert.Equal("let x = a != b\n", files["Thing.Part"].Text)
            Assert.Empty(files["Thing.Part"].Diagnostics)
            Assert.Contains(
                "a!=b",
                SelfMigratedCompilerSource.Compact(files["Thing.Part"].Text),
                StringComparison.Ordinal
            )
            await Assert.ThrowsAsync[InvalidOperationException](
                func () Task {
                    return SelfMigratedCompilerSource.LoadAsync(
                        root,
                        "tools/cs2gs/Demo",
                        preservePartialParts: true,
                        "Missing"
                    )
                }
            )
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup must not mask the test's own result.

            }
        }
    }

    @Fact
    async func SelfMigratedSource_DefaultRoot_ReusesCachedProjectAndFileAcrossCalls() {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4661-cache-" + Guid.NewGuid().ToString("N"))
        let parser = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax")
        let project = Path.Combine(root, "tools", "cs2gs", "Demo")
        Directory.CreateDirectory(parser)
        Directory.CreateDirectory(project)
        try {
            File.WriteAllText(Path.Combine(parser, "Parser.cs"), "namespace GSharp; public class Parser {}")
            var loads = 0
            let loader = func (_ string) Task[LoadedCSharpProject] {
                loads++
                return Task.FromResult(
                    CSharpProjectLoader.LoadInMemory(
                        [](string, string){
                            ("First.cs", "public class First { public static int X => 1; }"),
                            ("Second.cs", "public class Second { public static int Y => 2; }")
                        }
                    )
                )
            }
            let first = await SelfMigratedCompilerSource.LoadAsync(
                root,
                "tools/cs2gs/Demo",
                preservePartialParts: true,
                isDefaultRoot: true,
                loader,
                "First"
            )
            let firstRepeat = await SelfMigratedCompilerSource.LoadAsync(
                root,
                "tools/cs2gs/Demo",
                preservePartialParts: true,
                isDefaultRoot: true,
                loader,
                "First"
            )
            let second = await SelfMigratedCompilerSource.LoadAsync(
                root,
                "tools/cs2gs/Demo",
                preservePartialParts: true,
                isDefaultRoot: true,
                loader,
                "Second"
            )
            Assert.Equal(1, loads)
            Assert.Same(first["First"], firstRepeat["First"])
            Assert.Contains("First", first["First"].Text, StringComparison.Ordinal)
            Assert.Contains("Second", second["Second"].Text, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup must not mask the test's own result.

            }
        }
    }

    shared {
        func ManifestEntries() IEnumerable[[]object] -> FrozenCompilerSnapshots.Manifest.Select(
            (entry(Snapshot string, Live string, Region bool)) -> []object{entry.Snapshot, entry.Live, entry.Region}
        )
    }
}
