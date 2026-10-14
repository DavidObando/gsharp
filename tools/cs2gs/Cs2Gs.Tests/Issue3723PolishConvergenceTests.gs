// <copyright file="Issue3723PolishConvergenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3723: the redundant-`!!` polish loop has to run to a real fixed
/// point. One compile only reports what it managed to bind — it stops at the
/// first project that fails, and a nested assertion only becomes visibly
/// redundant once the one outside it is gone — so a fixed round budget leaves
/// the app red with GS0536 as its only diagnostic. These tests drive
/// `NullAssertionPolishPass.RunToFixedPoint`'s strict overload with a stand-in
/// compiler so the multi-generation and per-project shapes are exercised
/// without a real `dotnet build`.
class Issue3723PolishConvergenceTests {
    @Fact
    func RunToFixedPoint_ConvergesAcrossGenerations_PastTheOldThreeRoundBudget() {
        using let workspace = Issue3723PolishConvergenceTests.PolishWorkspace()
        let file = workspace.WriteFile("Nested.gs", "let a = b!!.c!!.d!!.e!!")
        let compiler = FakeCompiler(workspace.Files, PerLineFrontier)
        let outcome = NullAssertionPolishPass.RunToFixedPoint(compiler.Compile(), compiler.Compile, workspace.Files)
        Assert.False(outcome.CapExhausted)
        Assert.Equal(0, outcome.RemainingReports)
        Assert.Equal(4, outcome.Stripped)
        // Four generations: strictly more than the three rounds the loop used
        // to allow, which is what left the gate's apps red.
        Assert.Equal(4, outcome.Rounds)
        Assert.True(outcome.Result.Succeeded)
        Assert.Equal("let a = b.c.d.e", File.ReadAllText(file).TrimEnd())
    }

    @Fact
    func RunToFixedPoint_ConvergesWhenEachCompileOnlyReachesTheNextProject() {
        using let workspace = Issue3723PolishConvergenceTests.PolishWorkspace()
        // A compile reports nothing past the project it fails on, so the loop
        // sees one file's worth of assertions at a time however many are left.
        let files = Enumerable
            .Range(1, 5)
            .Select((i int32) -> workspace.WriteFile("Project" + i.ToString() + ".gs", "let a = b!!"))
            .ToArray()
        let compiler = FakeCompiler(workspace.Files, FirstFileFrontier)
        let outcome = NullAssertionPolishPass.RunToFixedPoint(compiler.Compile(), compiler.Compile, workspace.Files)
        Assert.False(outcome.CapExhausted)
        Assert.Equal(0, outcome.RemainingReports)
        Assert.Equal(5, outcome.Rounds)
        Assert.All(files, (f string) -> Assert.Equal("let a = b", File.ReadAllText(f).TrimEnd()))
    }

    @Fact
    func RunToFixedPoint_ReportsTheCapInsteadOfGivingUpSilently() {
        using let workspace = Issue3723PolishConvergenceTests.PolishWorkspace()
        workspace.WriteFile("Nested.gs", "let a = b!!.c!!.d!!.e!!")
        let compiler = FakeCompiler(workspace.Files, PerLineFrontier)
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(),
            compiler.Compile,
            workspace.Files,
            strippableRoot: nil,
            maxRounds: 2
        )
        Assert.True(outcome.CapExhausted)
        Assert.Equal(2, outcome.Rounds)
        Assert.Equal(2, outcome.Stripped)
        Assert.True(outcome.RemainingReports > 0)
        Assert.False(outcome.Result.Succeeded)
    }

    @Fact
    func RunToFixedPoint_RestoresAnAssertionTheRecompileTurnsOutToNeed() {
        using let workspace = Issue3723PolishConvergenceTests.PolishWorkspace()
        let file = workspace.WriteFile("Needed.gs", "let a = b!!")
        const original = "let a = b!!"
        // The first build passed (GS0536 is advisory there), so the polished
        // build that fails to bind is a regression: the assertion goes back.
        let initial = SdkCompileResult.Completed(
            0,
            output: nil,
            []GscDiagnostic{Diagnostic(NullAssertionPolishPass.DiagnosticId, "warning", file, 1, 10)},
            emittedAssemblyPath: "app.dll"
        )
        var recompiles = 0
        let Recompile = func () SdkCompileResult {
            recompiles++
            return SdkCompileResult.Completed(
                1,
                output: nil,
                []GscDiagnostic{Diagnostic("GS0400", "error", file, 1, 9)},
                emittedAssemblyPath: nil
            )
        }
        let outcome = NullAssertionPolishPass.RunToFixedPoint(initial, Recompile, workspace.Files)
        Assert.Equal(1, recompiles)
        Assert.Equal(1, outcome.Rounds)
        Assert.Same(initial, outcome.Result)
        Assert.Equal(original, File.ReadAllText(file).TrimEnd())
    }

    @Fact
    func RunToFixedPoint_StopsWhenNothingReportedCanBeStripped() {
        using let workspace = Issue3723PolishConvergenceTests.PolishWorkspace()
        let file = workspace.WriteFile("Stale.gs", "let a = b")
        var recompiles = 0
        let Recompile = func () SdkCompileResult {
            recompiles++
            return SdkCompileResult.Completed(0, nil, Array.Empty[GscDiagnostic](), "app.dll")
        }
        // A span that no longer holds `!!` is skipped rather than applied, so
        // the loop must end instead of spinning to the cap.
        let initial = SdkCompileResult.Completed(
            1,
            output: nil,
            []GscDiagnostic{Diagnostic(NullAssertionPolishPass.DiagnosticId, "error", file, 1, 10)},
            emittedAssemblyPath: nil
        )
        let outcome = NullAssertionPolishPass.RunToFixedPoint(initial, Recompile, workspace.Files)
        Assert.Equal(0, recompiles)
        Assert.False(outcome.CapExhausted)
        Assert.Equal(1, outcome.Rounds)
        Assert.Equal(0, outcome.Stripped)
        Assert.Equal("let a = b", File.ReadAllText(file).TrimEnd())
    }

    private class FakeCompiler {
        private let files IReadOnlyList[string]
        private let report(IReadOnlyList[string]) -> IEnumerable[(File string, Line int32, Column int32)]

        init(
            files IReadOnlyList[string],
            report(IReadOnlyList[string]) -> IEnumerable[(File string, Line int32, Column int32)]
        ) {
            this.files = files
            this.report = report
        }

        func Compile() SdkCompileResult {
            let diagnostics IReadOnlyList[GscDiagnostic] = this
                .report(this.files)
                .Select(
                (r(File string, Line int32, Column int32)) -> Issue3723PolishConvergenceTests.Diagnostic(
                    NullAssertionPolishPass.DiagnosticId,
                    "error",
                    r.File,
                    r.Line,
                    r.Column
                )
            )
                .ToList()
            return if diagnostics.Count == 0 {
                SdkCompileResult.Completed(0, nil, diagnostics, "app.dll")
            } else {
                SdkCompileResult.Completed(1, nil, diagnostics, nil)
            }
        }
    }

    private class PolishWorkspace : IDisposable {
        private let directory string
        private let files List[string] = List[string]()

        init() {
            this.directory = Path.Combine(
                Path.GetTempPath(),
                "Issue3723PolishConvergenceTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(this.directory)
        }

        prop Files IReadOnlyList[string] -> this.files

        func WriteFile(name string, lines ...string) string {
            let path = Path.Combine(this.directory, name)
            File.WriteAllLines(path, lines)
            this.files.Add(path)
            return path
        }

        func Dispose() {
            if Directory.Exists(this.directory) {
                Directory.Delete(this.directory, recursive: true)
            }
        }
    }

    shared {
        private func Diagnostic(
            id string,
            severity string,
            file string,
            line int32,
            column int32
        ) GscDiagnostic -> GscDiagnostic(id, "Redundant '!!'…", severity, file, line, column, line, column + 2)

        // Reports the leftmost `!!` of every line of every file — the stand-in
        // for gsc reporting one generation at a time: a nested assertion only
        // becomes visibly redundant once the one outside it is gone.
        private func PerLineFrontier(files IReadOnlyList[string]) sequence[(File string, Line int32, Column int32)] {
            for file in files {
                let lines = File.ReadAllLines(file)
                for var i = 0; i < lines.Length; i++ {
                    let index = lines[i].IndexOf("!!", StringComparison.Ordinal)
                    if index >= 0 {
                        yield(file, i + 1, index + 1)
                    }
                }
            }
        }

        // Reports every `!!` of the FIRST file that still has one: the shape of a
        // build that never gets past the project it fails on.
        private func FirstFileFrontier(files IReadOnlyList[string]) IEnumerable[
            (File string, Line int32, Column int32)
        ] {
            for file in files {
                let reports = List[(File string, Line int32, Column int32)]()
                let lines = File.ReadAllLines(file)
                for var i = 0; i < lines.Length; i++ {
                    for var index = lines[i].IndexOf("!!", StringComparison.Ordinal);
                        index >= 0;
                        index = lines[i].IndexOf("!!", index + 2, StringComparison.Ordinal) {
                        reports.Add((file, i + 1, index + 1))
                    }
                }
                if reports.Count > 0 {
                    return reports
                }
            }
            return Array.Empty[(File string, Line int32, Column int32)]()
        }
    }
}
