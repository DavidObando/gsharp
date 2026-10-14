// <copyright file="Issue3501ScaledTestParityBudgetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import Xunit

/// Issue #3501: the mirrored test-parity budget was one global constant
/// (ten minutes, #3931) with one hand-set exception (#4045). Applied to a suite
/// of a few thousand cases it stopped being a hang detector and became a size
/// limit: `tools/cs2gs/Cs2Gs.Tests` was killed for being big, and because
/// a killed `dotnet test` emits no VSTest summary the app produced NO
/// parity count at all — it could not be driven to green because nobody could
/// see what was failing. The budget is now derived from the number of
/// `[Fact]` methods the app's C# original declares.
///
/// These tests pin the four properties that make that safe: small apps keep the
/// tight budget so hangs still fail fast, large apps get a budget proportional
/// to their work, no app can grow past the ceiling that keeps a validation
/// shard inside its CI job limit, and the timeout diagnostic still names the
/// exact budget THIS app was held to (#3931's whole contribution).
class Issue3501ScaledTestParityBudgetTests {
    /// The floor is the point of the old constant and is kept: a suite of a
    /// few dozen tests that has not finished in ten minutes is stuck, not big,
    /// and raising its budget would only make every genuine hang more
    /// expensive. Roughly fifty of the corpus's apps are in this band.
    /// @param declaredTests A declared-[Fact] count in the small band.
    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(84))
    @InlineData(int32(189))
    func SmallSuitesKeepTheTightBudgetSoHangsStillFailFast(declaredTests int32) {
        Assert.Equal(TimeSpan.FromMinutes(10), SdkCompileRunner.MirroredTestRunTimeoutFor(declaredTests))
    }

    /// A count of zero means "the C# original could not be counted", not "this
    /// app has no tests" — the same best-effort contract
    /// `CountCSharpFactMethods` documents (#3869). An uncountable app must
    /// fall back to the floor, never to something smaller (or negative, if a
    /// future caller ever hands this a bad number).
    /// @param declaredTests An uncountable or nonsensical count.
    @Theory
    @InlineData(int32(0))
    @InlineData(int32(-1))
    @InlineData(int32(-2147483648))
    func AnUncountableAppFallsBackToTheFloor(declaredTests int32) {
        Assert.Equal(SdkCompileRunner.MirroredTestRunTimeout, SdkCompileRunner.MirroredTestRunTimeoutFor(declaredTests))
    }

    /// The case that motivated the change. `tools/cs2gs/Cs2Gs.Tests`
    /// declares 2,579 `[Fact]` methods and its C# ORIGINAL takes 21
    /// minutes to run 2,891 cases — so the migrated suite, which is slower,
    /// could never have completed inside ten minutes no matter how healthy it
    /// was. The budget it gets must comfortably clear that measured original,
    /// or the app stays a measurement blocker.
    @Fact
    func ASuiteOfSeveralThousandTestsOutrunsItsMeasuredCSharpOriginal() {
        let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(2579)
        Assert.True(
            budget >= TimeSpan.FromMinutes(42),
            "a 2,579-test suite got $budget, under 2x its C# original's measured 21 minutes."
        )
        Assert.True(budget <= SdkCompileRunner.MirroredTestRunTimeoutCeiling)
    }

    /// The ceiling is not a formality: `test/Core.Tests` declares 7,419
    /// test methods and the formula would ask for more than three hours.
    /// A validation shard writes its results only when its single
    /// `cs2gs validate` process finishes, so an app allowed to run past
    /// the job limit would cost the WHOLE shard's verdicts — trading one app's
    /// missing parity count for six apps'.
    @Fact
    func NoSuiteHoweverLargeExceedsTheCeiling() {
        Assert.Equal(SdkCompileRunner.MirroredTestRunTimeoutCeiling, SdkCompileRunner.MirroredTestRunTimeoutFor(7419))
        Assert.Equal(
            SdkCompileRunner.MirroredTestRunTimeoutCeiling,
            SdkCompileRunner.MirroredTestRunTimeoutFor(int32.MaxValue)
        )
    }

    /// Adding a test to a suite must never shorten its budget — a formula that
    /// is not monotonic could make a PR that adds tests fail a gate the
    /// unchanged code passes.
    @Fact
    func TheBudgetNeverShrinksAsASuiteGrows() {
        var previous = TimeSpan.Zero
        for declared in[]int32{0, 1, 100, 200, 400, 800, 1600, 2579, 4103, 7419, 20000} {
            let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared)
            Assert.True(
                budget >= previous,
                "$declared declared tests got $budget, less than the previous band's $previous."
            )
            previous = budget
        }
    }

    /// The budget is quoted verbatim in the `LIBRARY-TESTS-TIMED-OUT`
    /// message, so it is rounded to whole minutes: a budget printed as
    /// `01:10:41.5` reads like a measurement of the run rather than the
    /// policy it is.
    @Fact
    func TheBudgetIsWholeMinutesBecauseItIsQuotedInTheDiagnostic() {
        for declared in[]int32{397, 1234, 2579, 4103} {
            let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared)
            Assert.Equal(0, budget.Seconds)
            Assert.Equal(0, budget.Milliseconds)
        }
    }

    /// Issue #3931's contribution — the diagnostic names the budget that was
    /// exceeded — has to survive the budget becoming per-app. The number in the
    /// message must be the one the killed run was actually held to, not the
    /// global constant and not a recomputation that could disagree with it.
    @Fact
    func TheTimeoutDiagnosticNamesThisAppsOwnBudget() {
        let budget = TimeSpan.FromMinutes(70)
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            Issue3501ScaledTestParityBudgetTests.Context(),
            ProcessRunResult(-1, "[xUnit.net 00:09:59.9] Some.Test [FAIL]", string.Empty, true),
            budget
        )
        let artifact = Assert.Single(outcome.Artifacts)
        Assert.Equal("LIBRARY-TESTS-TIMED-OUT", artifact.Diagnostic!!.Id)
        Assert.Contains("01:10:00", artifact.Diagnostic!!.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("00:10:00", artifact.Diagnostic!!.Message, StringComparison.Ordinal)
    }

    /// The end-to-end claim, measured against the real corpus rather than a
    /// hand-picked number: the app this change exists to unblock must actually
    /// receive more than the old ten-minute constant. Counting is done by the
    /// production counter over this suite's own C# sources (2,579 `[Fact]`
    /// methods when this was written, for a 70-minute budget), so the test
    /// tracks the repository instead of restating a constant — if someone
    /// deletes two thousand tests, this correctly stops being true.
    ///
    /// It must ALSO stop being evaluated in the one place where it cannot hold:
    /// the self-migration gate runs this very suite from a G# mirror of itself,
    /// where `tools/cs2gs/Cs2Gs.Tests` contains `.gs` files and no C#
    /// at all. Measured, not assumed — the first complete migrated run under
    /// this change reported exactly that, and an unguarded version of this test
    /// would have added a 138th parity failure to the app the change exists to
    /// unblock. The guard asserts the condition that makes the claim
    /// inapplicable rather than swallowing an empty measurement.
    @Fact
    func TheAppThisUnblocksReceivesMoreThanTheOldConstant() {
        let suite = Path.Combine(RepoRoot(), "tools", "cs2gs", "Cs2Gs.Tests")
        let csharpSources = SuiteCSharpSources(suite)
        if csharpSources.Length == 0 {
            // The migrated mirror of ourselves. Prove that is what we are
            // looking at — a C#-sourced tree that suddenly has no C# would be a
            // real failure, not an inapplicable claim.
            Assert.NotEmpty(Directory.EnumerateFiles(suite, "*.gs", SearchOption.AllDirectories))
            return
        }
        let context = Issue3501ScaledTestParityBudgetTests.Context()
        for csFile in csharpSources {
            context.EmittedFiles.Add(
                EmittedGsFile(Path.GetFileName(csFile), Path.GetFileName(csFile), csFile, string.Empty)
            )
        }
        let declared = TestParityStage.CountCSharpFactMethods(context)
        let budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared)
        Assert.True(declared > 2000, "only $declared [Fact] methods counted in Cs2Gs.Tests.")
        Assert.True(
            budget > SdkCompileRunner.MirroredTestRunTimeout,
            "Cs2Gs.Tests ($declared tests) still gets only $budget."
        )
    }

    @Fact
    func FixtureDataAndBuildOutputAreNotSuiteSources() {
        let suite = Path.Combine(AppContext.BaseDirectory, "issue-4850-suite", Guid.NewGuid().ToString("N"))
        for relative in[]string{
            "A.cs",
            "Fixtures/Data.cs",
            "Fixtures/Nested/Deep.cs",
            "bin/B.cs",
            "obj/C.cs",
            "Sub/D.cs",
            "Robin/E.cs",
            "Subobj/F.cs"
        } {
            let path = Path.Combine(suite, relative.Replace('/', Path.DirectorySeparatorChar))
            Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
            File.WriteAllText(path, "class X {}")
        }
        let sources = SuiteCSharpSources(suite)
            .Select((path string) -> Path.GetRelativePath(suite, path).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal([]string{"A.cs", "Robin/E.cs", "Sub/D.cs", "Subobj/F.cs"}, sources)
    }

    shared {
        /// The suite's own C# test sources. `Fixtures/` holds C# DATA the tests
        /// read as text (issue #4850: the mirror now carries it verbatim), which is
        /// neither compiled nor a source of `[Fact]` methods, so a migrated tree
        /// that has only fixture `.cs` files is still the G# mirror of the suite.
        /// @param suite The suite directory.
        /// @returns The C# sources, excluding build output and fixture data.
        internal func SuiteCSharpSources(suite string)[]string {
            return Directory
                .EnumerateFiles(suite, "*.cs", SearchOption.AllDirectories)
                .Where(
                (path string) -> {
                    let segments = Path.GetRelativePath(suite, path).Split(
                        []char{'/', '\\'},
                        StringSplitOptions.RemoveEmptyEntries
                    )
                    let directories = segments.Take(segments.Length - 1).ToArray()
                    return !directories.Any(
                        (segment string) -> segment.Equals("bin", StringComparison.OrdinalIgnoreCase) || segment.Equals(
                            "obj",
                            StringComparison.OrdinalIgnoreCase
                        )
                    ) &&
                        !(directories.Length > 0 && directories[0].Equals("Fixtures", StringComparison.Ordinal))
                }
            )
                .ToArray()
        }

        private func Context() StageExecutionContext {
            let dir = Path.Combine(AppContext.BaseDirectory, "issue-3501-budget", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(dir)
            let projectPath = Path.Combine(dir, "Own.Tests.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
            let app = CorpusApp("test/Own.Tests", projectPath, TargetKind.Library)
            let options = PipelineOptions{OutputRoot: dir}
            let triage = TriageBuilder("run_1", "2026-09-08T00:00:00Z", "0.0.0", app.Id)
            return StageExecutionContext(app, options, GscInvoker("gsc.dll"), dir, triage)
        }

        private func RepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil && !Directory.Exists(Path.Combine(dir.FullName, "build")) {
                dir = dir.Parent
            }
            Assert.NotNull(dir)
            return dir!!.FullName
        }
    }
}
