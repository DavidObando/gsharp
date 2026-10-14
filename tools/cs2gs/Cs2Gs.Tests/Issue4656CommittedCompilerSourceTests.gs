// <copyright file="Issue4656CommittedCompilerSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.IO
import Xunit

/// Issue #4656: the self-migration inventories read the committed tree in its
/// own language, and a count over nothing is a failure, not a zero.
class Issue4656CommittedCompilerSourceTests {
    @Fact
    func Language_IsDecidedByTheParserFile_AndAMixedTreeIsRejected() {
        let csharp = Tree(".cs")
        let gsharp = Tree(".gs")
        let mixed = Tree(".cs", ".gs")
        let neither = Tree()
        try {
            Assert.False(CommittedCompilerSource.IsGSharp(csharp))
            Assert.True(CommittedCompilerSource.IsGSharp(gsharp))
            Assert.Throws[InvalidOperationException](
                func () object? {
                    return CommittedCompilerSource.IsGSharp(mixed)
                }
            )
            Assert.Throws[InvalidOperationException](
                func () object? {
                    return CommittedCompilerSource.IsGSharp(neither)
                }
            )
        } finally {
            Delete(csharp, gsharp, mixed, neither)
        }
    }

    @Fact
    func GSharpFiles_FailsOnAnEmptyOrMissingDirectory() {
        // Deliberately under the test output (a bin/ directory): a root that
        // itself sits below bin/ must still be scanned.
        let root = Tree(".gs")
        try {
            Assert.Single(CommittedCompilerSource.GSharpFiles(root, "src/Core"))
            Assert.Single(CommittedCompilerSource.GSharpFiles(root, "src", "src/Core"))
            Directory.CreateDirectory(Path.Combine(root, "tools", "empty"))
            Assert.Throws[InvalidOperationException](
                func () object? {
                    return CommittedCompilerSource.GSharpFiles(root, "tools/empty")
                }
            )
            Assert.Throws[DirectoryNotFoundException](
                func () object? {
                    return CommittedCompilerSource.GSharpFiles(root, "tools/missing")
                }
            )
        } finally {
            Delete(root)
        }
    }

    /// Build output is judged below the scanned root only: obj/ and bin/
    /// beneath it are skipped (any case), a root that itself sits under a bin/
    /// directory is not.
    @Fact
    func IsBuildOutput_JudgesOnlySegmentsBelowTheRoot() {
        let root = Path.Combine(Path.DirectorySeparatorChar + "work", "bin", "Release", "tree")
        Assert.True(CommittedCompilerSource.IsBuildOutput(root, Path.Combine(root, "src", "obj", "A.gs")))
        Assert.True(CommittedCompilerSource.IsBuildOutput(root, Path.Combine(root, "src", "Bin", "A.gs")))
        Assert.False(CommittedCompilerSource.IsBuildOutput(root, Path.Combine(root, "src", "Core", "A.gs")))
        Assert.False(CommittedCompilerSource.IsBuildOutput(root, Path.Combine(root, "src", "binary", "A.gs")))
    }

    shared {
        private func Delete(roots ...string) {
            // Best-effort cleanup: a failure here must never mask the test's own result.
            for root in roots {
                try {
                    if Directory.Exists(root) {
                        Directory.Delete(root, recursive: true)
                    }
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func Tree(parserExtensions ...string) string {
            let root = Path.Combine(
                AppContext.BaseDirectory,
                "issue-4656-committed-source",
                Guid.NewGuid().ToString("N")
            )
            let syntax = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax")
            Directory.CreateDirectory(syntax)
            for extension in parserExtensions {
                File.WriteAllText(Path.Combine(syntax, "Parser" + extension), string.Empty)
            }
            return root
        }
    }
}
