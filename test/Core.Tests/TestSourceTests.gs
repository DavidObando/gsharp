// <copyright file="TestSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import System
import System.IO
import Xunit

open class TestSourceTests {
    @Fact
    func ConfiguredSourceRoot_IsUsedInsteadOfExecutionTree() {
        let root = TestSource.Root
        Assert.Equal(root, TestSource.FindRoot(root, Path.Combine(root, "not-the-execution-tree")))
        Assert.NotEmpty(TestSource.SourceFiles(SearchOption.TopDirectoryOnly, "src/Core/CodeAnalysis/Emit"))
    }

    @Fact
    func MissingConfiguredSourceRoot_DoesNotFallBackToExecutionTree() {
        Assert.Throws[DirectoryNotFoundException](
            func () object? {
                return TestSource.FindRoot(
                    Path.Combine(TestSource.Root, Guid.NewGuid().ToString("N")),
                    AppContext.BaseDirectory
                )
            }
        )
    }

    @Fact
    func MigratedOnlyTree_CannotProduceVacuousSourceGuards() {
        let directory = NewTree()
        try {
            File.WriteAllText(Path.Combine(directory, "GSharp.sln"), string.Empty)
            Assert.Throws[DirectoryNotFoundException](
                func () object? {
                    return TestSource.FindRoot(directory, TestSource.Root)
                }
            )
            Assert.Throws[DirectoryNotFoundException](
                func () object? {
                    return TestSource.FindRoot(nil, directory)
                }
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Issue #4656: after the cut-over the compiler's sources are G#. A tree
    /// holding `Parser.gs` is a valid root and reports the G# extension,
    /// so guards read `.gs` instead of failing at root resolution.
    @Fact
    func GSharpSourceTree_IsAValidRoot_AndReportsItsExtension() {
        let directory = NewTree()
        try {
            File.WriteAllText(Path.Combine(directory, "GSharp.slnx"), string.Empty)
            WriteParser(directory, ".gs")
            Assert.Equal(directory, TestSource.FindRoot(directory, AppContext.BaseDirectory))
            Assert.Equal(TestSource.GSharpExtension, TestSource.SourceExtensionOf(directory))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// A tree holding the parser in BOTH languages is ambiguous and rejected,
    /// rather than letting a guard silently read the stale half.
    @Fact
    func MixedLanguageTree_IsRejected() {
        let directory = NewTree()
        try {
            File.WriteAllText(Path.Combine(directory, "GSharp.sln"), string.Empty)
            WriteParser(directory, ".cs")
            WriteParser(directory, ".gs")
            Assert.Throws[DirectoryNotFoundException](
                func () object? {
                    return TestSource.FindRoot(directory, AppContext.BaseDirectory)
                }
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Issue #4656: a scan that finds nothing, or names a directory that does
    /// not exist, throws instead of handing a guard an empty list to pass on.
    @Fact
    func EmptyOrMissingScan_Throws() {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return TestSource.SourceFilesMatching(
                    "NoSuchFile_" + Guid.NewGuid().ToString("N"),
                    SearchOption.AllDirectories,
                    "src/Core"
                )
            }
        )
        Assert.Throws[DirectoryNotFoundException](
            func () object? {
                return TestSource.SourceFiles(SearchOption.AllDirectories, "src/Core/NoSuchDirectory")
            }
        )
    }

    /// Issue #4656: a C# fixture that a test compiles with Roslyn reads the live
    /// file while it exists, refuses a stale snapshot, and falls back to the
    /// snapshot once the live file is G#.
    @Fact
    func CSharpFixtureSource_UsesLiveFile_RejectsDrift_AndFallsBackToSnapshot() {
        let directory = NewTree()
        try {
            let fixtures = Path.Combine(directory, "test", "Core.Tests", "Fixtures")
            let snapshots = Path.Combine(directory, "test", "Core.Tests", "TestData", "CSharpFixtureSources")
            Directory.CreateDirectory(fixtures)
            Directory.CreateDirectory(snapshots)
            const source = `// <copyright file="F.cs" company="GSharp">
namespace GSharp.Core.Tests.Fixtures;
public class F { }
`
            File.WriteAllText(Path.Combine(snapshots, "F.cs.txt"), source)
            File.WriteAllText(Path.Combine(fixtures, "F.cs"), source)
            Assert.Equal(source, TestSource.CSharpFixtureSource(directory, "F.cs"))
            File.WriteAllText(Path.Combine(fixtures, "F.cs"), source + "public class G { }\n")
            Assert.Throws[InvalidOperationException](
                func () object? {
                    return TestSource.CSharpFixtureSource(directory, "F.cs")
                }
            )
            File.Delete(Path.Combine(fixtures, "F.cs"))
            Assert.Equal(source, TestSource.CSharpFixtureSource(directory, "F.cs"))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Every committed fixture snapshot is usable: while its live C# fixture
    /// exists it must match it exactly (drift fails); once the fixture is G#,
    /// the snapshot itself must hold the expected C# fixture namespace.
    @Fact
    func CSharpFixtureSnapshots_AreCurrent() {
        let snapshots = Directory.GetFiles(
            Path.Combine(TestSource.Root, "test", "Core.Tests", "TestData", "CSharpFixtureSources"),
            "*.cs.txt"
        )
        Assert.NotEmpty(snapshots)
        for snapshot in snapshots {
            Assert.NotEmpty(TestSource.CSharpFixtureSource(Path.GetFileNameWithoutExtension(snapshot)))
        }
    }

    shared {
        private func NewTree() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "source-root-tests", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func WriteParser(root string, extension string) {
            let syntax = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax")
            Directory.CreateDirectory(syntax)
            File.WriteAllText(Path.Combine(syntax, "Parser" + extension), string.Empty)
        }
    }
}
