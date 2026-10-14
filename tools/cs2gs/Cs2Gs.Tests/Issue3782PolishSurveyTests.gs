// <copyright file="Issue3782PolishSurveyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3782: the redundant-`!!` polish loop used to advance ONE project
/// per round, because the migrated tree builds warnings-as-errors and such a
/// build reports nothing past the first project it fails on.
/// `tools/cs2gs/Cs2Gs.Tests` pulls twelve projects into its graph, so it
/// needed ~40 rounds against a cap of 12 and finished with 14752 GS0536 still
/// standing — the only app in the corpus that failed to converge, and the reason
/// the corpus-wide `!!` count moved with shard packing.
///
/// The fix is SURVEY mode: from the second round on, the recompile demotes
/// GS0536 back to a warning so one build walks the whole graph and reports every
/// redundant assertion at once. Convergence then depends on assertion NESTING,
/// not on graph depth. These tests drive the loop with a stand-in compiler that
/// models both build shapes.
class Issue3782PolishSurveyTests {
    @Fact
    func DeepGraph_WithoutSurvey_ExhaustsTheCap() {
        // The pre-#3782 behaviour, kept as the control: twenty project levels
        // against the default cap of twelve leaves the app red with GS0536 as
        // its only diagnostic. This is exactly the Cs2Gs.Tests shape.
        using let workspace = Issue3782PolishSurveyTests.PolishWorkspace()
        let compiler = GraphCompiler(WriteGraph(workspace, projects: 20))
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(survey: false),
            () -> compiler.Compile(survey: false),
            workspace.Files
        )
        Assert.True(outcome.CapExhausted)
        Assert.Equal(NullAssertionPolishPass.DefaultMaxRounds, outcome.Rounds)
        Assert.True(outcome.RemainingReports > 0)
        Assert.False(outcome.Result.Succeeded)
    }

    @Fact
    func DeepGraph_WithSurvey_ConvergesWellInsideTheCap() {
        using let workspace = Issue3782PolishSurveyTests.PolishWorkspace()
        let compiler = GraphCompiler(WriteGraph(workspace, projects: 20))
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(survey: false),
            compiler.Compile,
            workspace.Files
        )
        Assert.False(outcome.CapExhausted)
        Assert.Equal(0, outcome.RemainingReports)
        Assert.True(outcome.Result.Succeeded)
        Assert.All(
            workspace.Files,
            (f string) -> Assert.DoesNotContain("!!", File.ReadAllText(f), StringComparison.Ordinal)
        )
        // Depth stops being a cost. Round 1 strips what the strict compile saw
        // (project 1) and recompiles strictly, which surfaces project 2; round 2
        // strips that and SURVEYS, which surfaces the remaining eighteen at
        // once; round 3 strips them all. Three rounds and a closing strict
        // confirmation for a twenty-project graph — the strict loop needs
        // twenty rounds for the same tree and the cap only allows twelve.
        Assert.Equal(3, outcome.Rounds)
        Assert.Equal(4, outcome.Builds)
    }

    @Fact
    func ShallowGraph_DoesNoMoreWorkThanBefore() {
        // The guard on the fix: an app whose whole graph is reported by its
        // first compile must not pay for survey mode or for a confirmation
        // build. One round, one build — byte for byte the old cost.
        using let workspace = Issue3782PolishSurveyTests.PolishWorkspace()
        let compiler = GraphCompiler(WriteGraph(workspace, projects: 1))
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(survey: false),
            compiler.Compile,
            workspace.Files
        )
        Assert.False(outcome.CapExhausted)
        Assert.Equal(0, outcome.RemainingReports)
        Assert.Equal(1, outcome.Rounds)
        Assert.Equal(1, outcome.Builds)
        // Two compiles all told: the stage's own first build, which the loop
        // does not pay for, and the one recompile the single round needed.
        Assert.Equal(2, compiler.Compiles)
        Assert.Empty(compiler.SurveyCompiles)
    }

    @Fact
    func TheResultAlwaysComesFromAStrictBuild() {
        // A survey build sees GS0536 as a warning, so its success proves
        // nothing about the gate's warnings-as-errors bar. Whatever the loop
        // returns must have been produced with the demotion OFF.
        using let workspace = Issue3782PolishSurveyTests.PolishWorkspace()
        let compiler = GraphCompiler(WriteGraph(workspace, projects: 6))
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(survey: false),
            compiler.Compile,
            workspace.Files
        )
        Assert.Contains(true, compiler.SurveyRequests)
        Assert.False(compiler.SurveyRequests[compiler.SurveyRequests.Count - 1])
        Assert.Same(compiler.LastStrictResult, outcome.Result)
        Assert.Equal(0, outcome.RemainingReports)
    }

    @Fact
    func AnSdkThatIgnoresTheDemotion_FallsBackToTheStrictLoop() {
        // WarningsNotAsErrors is plumbed through the packed SDK, so a stale
        // nupkg can silently ignore it. The loop must then behave exactly like
        // the pre-#3782 one — and in particular must NOT keep paying for a
        // strict confirmation build after every survey attempt.
        using let workspace = Issue3782PolishSurveyTests.PolishWorkspace()
        let compiler = GraphCompiler(WriteGraph(workspace, projects: 4)){HonoursSurvey = false}
        let outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(survey: false),
            compiler.Compile,
            workspace.Files
        )
        Assert.False(outcome.CapExhausted)
        Assert.Equal(0, outcome.RemainingReports)
        Assert.Equal(4, outcome.Rounds)
        // One strip round per project, as before, plus ONE closing strict
        // confirmation — not one confirmation per attempted survey.
        Assert.Equal(5, outcome.Builds)
    }

    @Fact
    func RemainingReportsCountsDistinctSpans() {
        // MSBuild echoes every diagnostic again in its end-of-build summary, so
        // the raw diagnostic count double-reports once GS0536 arrives as a
        // warning. The number the gate publishes has to be spans, not lines.
        let diagnostic = GscDiagnostic(
            NullAssertionPolishPass.DiagnosticId,
            "Redundant '!!'…",
            "warning",
            "/x/A.gs",
            3,
            7,
            3,
            9
        )
        let outcome = NullAssertionPolishPass.PolishLoopOutcome(
            SdkCompileResult.Completed(0, nil, []GscDiagnostic{diagnostic, diagnostic}, "app.dll"),
            rounds: 1,
            stripped: 0,
            capExhausted: false,
            builds: 1
        )
        Assert.Equal(1, outcome.RemainingReports)
    }

    /// A stand-in for the mirrored SDK build. A STRICT compile stops at the
    /// first file still holding a `!!` and reports only that one (the
    /// warnings-as-errors shape); a SURVEY compile reports every file's, and
    /// succeeds, because GS0536 is a warning there.
    private class GraphCompiler {
        private let files IReadOnlyList[string]

        init(files IReadOnlyList[string]) {
            SurveyRequests = List[bool]()
            this.files = files
        }

        /// Gets or sets a value indicating whether survey mode has any effect.
        private var _honoursSurvey bool = true

        prop HonoursSurvey bool {
            get {
                return _honoursSurvey
            }
            set {
                _honoursSurvey = value
            }
        }

        prop SurveyRequests List[bool] {
            get;
        }

        prop Compiles int32 -> this.SurveyRequests.Count
        prop SurveyCompiles IEnumerable[bool] -> this.SurveyRequests.Where((r bool) -> r)

        prop LastStrictResult SdkCompileResult {
            get;
            private set;
        }

        func Compile(survey bool) SdkCompileResult {
            this.SurveyRequests.Add(survey)
            let wide = survey && this.HonoursSurvey
            let reports = List[GscDiagnostic]()
            for file in this.files {
                let lines = File.ReadAllLines(file)
                for var i = 0; i < lines.Length; i++ {
                    let index = lines[i].IndexOf("!!", StringComparison.Ordinal)
                    if index >= 0 {
                        reports.Add(
                            GscDiagnostic(
                                NullAssertionPolishPass.DiagnosticId,
                                "Redundant '!!'…",
                                if wide {
                                    "warning"
                                } else {
                                    "error"
                                },
                                file,
                                i + 1,
                                index + 1,
                                i + 1,
                                index + 3
                            )
                        )
                    }
                }
                if reports.Count > 0 && !wide {
                    break
                }
            }
            // A survey build never fails on GS0536; a strict one always does.
            let result = if reports.Count == 0 || wide {
                SdkCompileResult.Completed(0, nil, reports, "app.dll")
            } else {
                SdkCompileResult.Completed(1, nil, reports, nil)
            }
            if !survey {
                this.LastStrictResult = result
            }
            return result
        }
    }

    private class PolishWorkspace : IDisposable {
        private let directory string
        private let files List[string] = List[string]()

        init() {
            this.directory = Path.Combine(
                Path.GetTempPath(),
                "Issue3782PolishSurveyTests",
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
        // One `!!` per project file, which the strict build reports one project at
        // a time and the survey build reports all at once.
        private func WriteGraph(workspace Issue3782PolishSurveyTests.PolishWorkspace, projects int32) IReadOnlyList[
            string
        ] -> Enumerable
            .Range(1, projects)
            .Select((i int32) -> workspace.WriteFile("Project" + i.ToString() + ".gs", "let a = b!!"))
            .ToList()
    }
}
