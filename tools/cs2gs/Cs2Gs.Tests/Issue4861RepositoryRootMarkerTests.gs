// <copyright file="Issue4861RepositoryRootMarkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #4861: the repository root used to be found by probing the literal
/// file name `GSharp.sln` from about 100 places, so the cut-over (which
/// keeps only the generated `GSharp.slnx`) had to rewrite them all by
/// text. There is now one rule, (cref:RepositoryRootMarker), accepting
/// either spelling. These tests fail if the rule stops accepting the
/// `.slnx`, if the test-side copy drifts from it, or if a new
/// literal solution name appears.
class Issue4861RepositoryRootMarkerTests : IDisposable {
    private let root string = Path.Combine(Path.GetTempPath(), "gs4861-" + Guid.NewGuid().ToString("N"))

    init() {
        Directory.CreateDirectory(this.root)
    }

    func Dispose() {
        Directory.Delete(this.root, recursive: true)
    }

    @Theory
    @InlineData("GSharp.sln")
    @InlineData("GSharp.slnx")
    func EitherSolutionSpelling_AnchorsTheRoot(solution string) {
        File.WriteAllText(Path.Combine(this.root, solution), string.Empty)
        Assert.True(RepositoryRootMarker.IsRoot(this.root))
    }

    @Fact
    func NoSolution_IsNotARoot() {
        File.WriteAllText(Path.Combine(this.root, "Other.slnx"), string.Empty)
        Assert.False(RepositoryRootMarker.IsRoot(this.root))
    }

    @Theory
    @InlineData("GSharp.sln")
    @InlineData("GSharp.slnx")
    func FindRepoRoot_WalksUpToEitherSolutionSpelling(solution string) {
        File.WriteAllText(Path.Combine(this.root, solution), string.Empty)
        File.WriteAllText(Path.Combine(this.root, "nuget.config"), "<configuration />")
        let nested = Path.Combine(this.root, "out", "bin", "Release", "Cs2Gs.Cli")
        Directory.CreateDirectory(nested)
        Assert.Equal(this.root, GsharpTestProjectRunner.FindRepoRootAbove(nested))
    }

    @Fact
    func FindRepoRoot_RequiresNuGetConfigBesideTheSolution() {
        File.WriteAllText(Path.Combine(this.root, "GSharp.slnx"), string.Empty)
        Assert.Null(GsharpTestProjectRunner.FindRepoRootAbove(this.root))
    }

    /// The test projects carry their own copy of the rule
    /// (`test/Shared/RepositoryRootMarker.cs`) because they cannot
    /// reference cs2gs. It must name exactly the spellings the product rule does.
    @Fact
    func SharedTestCopy_NamesTheSameSolutionFiles() {
        let repo = LocateRepoRoot()
        let shared = SourceOf(Path.Combine(repo, "test", "Shared", "RepositoryRootMarker"))
        let spellings = Regex
            .Matches(shared, "\"(GSharp\\.slnx?)\"")
            .Select((m Match) -> m.Groups[1].Value)
            .OrderBy((s string) -> s, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal(
            RepositoryRootMarker.SolutionFileNames.OrderBy((s string) -> s, StringComparer.Ordinal).ToArray(),
            spellings
        )
        // The retained-C# Visual Studio test island carries its own copy rather than linking the shared file.
        // It is excluded from self-migration by policy, so a migrated tree has neither spelling of it (#4878);
        // the C# checkout (the normal CI run) always has it, and that is where this half is enforced.
        let islandPath = Path.Combine(repo, "src", "vs-gsharp", "test", "VsGsharp.UnitTests", "RepositoryRootMarker.cs")
        if File.Exists(islandPath) {
            Assert.Equal(
                spellings,
                Regex
                    .Matches(File.ReadAllText(islandPath), "\"(GSharp\\.slnx?)\"")
                    .Select((m Match) -> m.Groups[1].Value)
                    .OrderBy((s string) -> s, StringComparer.Ordinal)
                    .ToArray()
            )
        }
    }

    /// No source file may spell the solution name as a string literal, because
    /// any probe built from one (`File.Exists`, `FileInfo.Exists`,
    /// `Path.Join`, `Directory.GetFiles`, ...) would anchor the root
    /// on a single spelling again. Root discovery goes through
    /// (cref:RepositoryRootMarker). The files below legitimately name the
    /// file: the two marker implementations, this test, and tests that write a
    /// fixture solution into a scratch directory.
    @Fact
    func NoSourceFileSpellsALiteralSolutionName() {
        let repo = LocateRepoRoot()
        let literal = Regex("\"GSharp\\.slnx?\"")
        let allowed = []string{
            "test/Shared/RepositoryRootMarker",
            "src/vs-gsharp/test/VsGsharp.UnitTests/RepositoryRootMarker",
            "tools/cs2gs/Cs2Gs.Pipeline/RepositoryRootMarker",
            "tools/cs2gs/Cs2Gs.Tests/Issue4861RepositoryRootMarkerTests",
            "test/Core.Tests/TestSourceTests",
            "tools/cs2gs/Cs2Gs.Tests/Adr0151IfLetExpressionTranslationTests"
        }
        let offenders = []string{"test", "tools", "src"}
            .SelectMany(
            func (d string) IEnumerable[string] {
                return Directory.EnumerateFiles(Path.Combine(repo, d), "*.*", SearchOption.AllDirectories)
            }
        )
            .Where(
            (f string) -> (
                f.EndsWith(".cs", StringComparison.Ordinal) || f.EndsWith(".gs", StringComparison.Ordinal)
            ) &&
                !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar) && !f.Contains(
                Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar
            )
        )
            .Where((f string) -> !allowed.Contains(RepoRelativeWithoutExtension(repo, f)))
            .Where((f string) -> literal.IsMatch(File.ReadAllText(f)))
            .Select((f string) -> Path.GetRelativePath(repo, f))
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .ToArray()
        Assert.Empty(offenders)
    }

    /// Issue #4878: `test/Shared/RepositoryRootMarker.cs` is linked into test projects whose
    /// `<Nullable>` settings differ, and `TranslateStage` rejects a linked source that
    /// translates differently per project (the whole-repository translate pass crashed with
    /// "translates differently in multiple projects"; one project printed
    /// `directory string?` with `directory!!`, another plain `directory string`). The
    /// divergence only appears across the whole repository, so it cannot be reproduced on one file;
    /// the file therefore pins its own nullable context, and this test keeps the pin (and every
    /// copy of it) from being dropped. `migrate --translate-only` is the end-to-end check.
    @Fact
    func LinkedMarker_PinsItsOwnNullableContext() {
        let repo = LocateRepoRoot()
        let copies[]string = []string{
            Path.Combine(repo, "test", "Shared", "RepositoryRootMarker"),
            Path.Combine(repo, "src", "vs-gsharp", "test", "VsGsharp.UnitTests", "RepositoryRootMarker")
        }
        for copy in copies {
            let path = copy + ".cs"
            if !File.Exists(path) && !File.Exists(copy + ".gs") {
                continue // policy-excluded from self-migration (see SharedTestCopy_NamesTheSameSolutionFiles)

            }
            // A migrated .gs has no #nullable directive: only the C# source is checked.
            if File.Exists(path) {
                Assert.Contains("#nullable enable annotations", File.ReadAllText(path), StringComparison.Ordinal)
            }
        }
    }

    shared {
        // Forward-slash, extension-less, so the allowlist matches the .cs and the migrated .gs spelling alike.
        private func RepoRelativeWithoutExtension(repo string, file string) string {
            let relative = Path.GetRelativePath(repo, file).Replace('\\', '/')
            return relative.Substring(0, relative.LastIndexOf('.'))
        }

        private func SourceOf(withoutExtension string) string {
            let cs = withoutExtension + ".cs"
            return File.ReadAllText(
                if File.Exists(cs) {
                    cs
                } else {
                    withoutExtension + ".gs"
                }
            )
        }

        private func LocateRepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            throw InvalidOperationException("repository root not found from " + AppContext.BaseDirectory)
        }
    }
}
