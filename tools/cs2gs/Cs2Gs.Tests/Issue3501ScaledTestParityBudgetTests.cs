// <copyright file="Issue3501ScaledTestParityBudgetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501: the mirrored test-parity budget was one global constant
/// (ten minutes, #3931) with one hand-set exception (#4045). Applied to a suite
/// of a few thousand cases it stopped being a hang detector and became a size
/// limit: <c>tools/cs2gs/Cs2Gs.Tests</c> was killed for being big, and because
/// a killed <c>dotnet test</c> emits no VSTest summary the app produced NO
/// parity count at all — it could not be driven to green because nobody could
/// see what was failing. The budget is now derived from the number of
/// <c>[Fact]</c> methods the app's C# original declares.
/// <para>
/// These tests pin the four properties that make that safe: small apps keep the
/// tight budget so hangs still fail fast, large apps get a budget proportional
/// to their work, no app can grow past the ceiling that keeps a validation
/// shard inside its CI job limit, and the timeout diagnostic still names the
/// exact budget THIS app was held to (#3931's whole contribution).
/// </para>
/// </summary>
public sealed class Issue3501ScaledTestParityBudgetTests
{
    /// <summary>
    /// The floor is the point of the old constant and is kept: a suite of a
    /// few dozen tests that has not finished in ten minutes is stuck, not big,
    /// and raising its budget would only make every genuine hang more
    /// expensive. Roughly fifty of the corpus's apps are in this band.
    /// </summary>
    /// <param name="declaredTests">A declared-[Fact] count in the small band.</param>
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(84)]
    [InlineData(189)]
    public void SmallSuitesKeepTheTightBudgetSoHangsStillFailFast(int declaredTests)
    {
        Assert.Equal(
            TimeSpan.FromMinutes(10),
            SdkCompileRunner.MirroredTestRunTimeoutFor(declaredTests));
    }

    /// <summary>
    /// A count of zero means "the C# original could not be counted", not "this
    /// app has no tests" — the same best-effort contract
    /// <c>CountCSharpFactMethods</c> documents (#3869). An uncountable app must
    /// fall back to the floor, never to something smaller (or negative, if a
    /// future caller ever hands this a bad number).
    /// </summary>
    /// <param name="declaredTests">An uncountable or nonsensical count.</param>
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void AnUncountableAppFallsBackToTheFloor(int declaredTests)
    {
        Assert.Equal(
            SdkCompileRunner.MirroredTestRunTimeout,
            SdkCompileRunner.MirroredTestRunTimeoutFor(declaredTests));
    }

    /// <summary>
    /// The case that motivated the change. <c>tools/cs2gs/Cs2Gs.Tests</c>
    /// declares 2,579 <c>[Fact]</c> methods and its C# ORIGINAL takes 21
    /// minutes to run 2,891 cases — so the migrated suite, which is slower,
    /// could never have completed inside ten minutes no matter how healthy it
    /// was. The budget it gets must comfortably clear that measured original,
    /// or the app stays a measurement blocker.
    /// </summary>
    [Fact]
    public void ASuiteOfSeveralThousandTestsOutrunsItsMeasuredCSharpOriginal()
    {
        TimeSpan budget = SdkCompileRunner.MirroredTestRunTimeoutFor(2579);

        Assert.True(
            budget >= TimeSpan.FromMinutes(42),
            $"a 2,579-test suite got {budget}, under 2x its C# original's measured 21 minutes.");
        Assert.True(budget <= SdkCompileRunner.MirroredTestRunTimeoutCeiling);
    }

    /// <summary>
    /// The ceiling is not a formality: <c>test/Core.Tests</c> declares 7,419
    /// test methods and the formula would ask for more than three hours.
    /// A validation shard writes its results only when its single
    /// <c>cs2gs validate</c> process finishes, so an app allowed to run past
    /// the job limit would cost the WHOLE shard's verdicts — trading one app's
    /// missing parity count for six apps'.
    /// </summary>
    [Fact]
    public void NoSuiteHoweverLargeExceedsTheCeiling()
    {
        Assert.Equal(
            SdkCompileRunner.MirroredTestRunTimeoutCeiling,
            SdkCompileRunner.MirroredTestRunTimeoutFor(7419));
        Assert.Equal(
            SdkCompileRunner.MirroredTestRunTimeoutCeiling,
            SdkCompileRunner.MirroredTestRunTimeoutFor(int.MaxValue));
    }

    /// <summary>
    /// Adding a test to a suite must never shorten its budget — a formula that
    /// is not monotonic could make a PR that adds tests fail a gate the
    /// unchanged code passes.
    /// </summary>
    [Fact]
    public void TheBudgetNeverShrinksAsASuiteGrows()
    {
        TimeSpan previous = TimeSpan.Zero;
        foreach (int declared in new[] { 0, 1, 100, 200, 400, 800, 1600, 2579, 4103, 7419, 20000 })
        {
            TimeSpan budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared);
            Assert.True(
                budget >= previous,
                $"{declared} declared tests got {budget}, less than the previous band's {previous}.");
            previous = budget;
        }
    }

    /// <summary>
    /// The budget is quoted verbatim in the <c>LIBRARY-TESTS-TIMED-OUT</c>
    /// message, so it is rounded to whole minutes: a budget printed as
    /// <c>01:10:41.5</c> reads like a measurement of the run rather than the
    /// policy it is.
    /// </summary>
    [Fact]
    public void TheBudgetIsWholeMinutesBecauseItIsQuotedInTheDiagnostic()
    {
        foreach (int declared in new[] { 397, 1234, 2579, 4103 })
        {
            TimeSpan budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared);
            Assert.Equal(0, budget.Seconds);
            Assert.Equal(0, budget.Milliseconds);
        }
    }

    /// <summary>
    /// Issue #3931's contribution — the diagnostic names the budget that was
    /// exceeded — has to survive the budget becoming per-app. The number in the
    /// message must be the one the killed run was actually held to, not the
    /// global constant and not a recomputation that could disagree with it.
    /// </summary>
    [Fact]
    public void TheTimeoutDiagnosticNamesThisAppsOwnBudget()
    {
        TimeSpan budget = TimeSpan.FromMinutes(70);

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            Context(),
            new ProcessRunResult(-1, "[xUnit.net 00:09:59.9] Some.Test [FAIL]", string.Empty, true),
            budget);

        TriageArtifact artifact = Assert.Single(outcome.Artifacts);
        Assert.Equal("LIBRARY-TESTS-TIMED-OUT", artifact.Diagnostic.Id);
        Assert.Contains("01:10:00", artifact.Diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("00:10:00", artifact.Diagnostic.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The end-to-end claim, measured against the real corpus rather than a
    /// hand-picked number: the app this change exists to unblock must actually
    /// receive more than the old ten-minute constant. Counting is done by the
    /// production counter over this suite's own C# sources (2,579 <c>[Fact]</c>
    /// methods when this was written, for a 70-minute budget), so the test
    /// tracks the repository instead of restating a constant — if someone
    /// deletes two thousand tests, this correctly stops being true.
    /// <para>
    /// It must ALSO stop being evaluated in the one place where it cannot hold:
    /// the self-migration gate runs this very suite from a G# mirror of itself,
    /// where <c>tools/cs2gs/Cs2Gs.Tests</c> contains <c>.gs</c> files and no C#
    /// at all. Measured, not assumed — the first complete migrated run under
    /// this change reported exactly that, and an unguarded version of this test
    /// would have added a 138th parity failure to the app the change exists to
    /// unblock. The guard asserts the condition that makes the claim
    /// inapplicable rather than swallowing an empty measurement.
    /// </para>
    /// </summary>
    [Fact]
    public void TheAppThisUnblocksReceivesMoreThanTheOldConstant()
    {
        string suite = Path.Combine(RepoRoot(), "tools", "cs2gs", "Cs2Gs.Tests");
        string[] csharpSources = Directory
            .EnumerateFiles(suite, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal) &&
                !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                    StringComparison.Ordinal))
            .ToArray();
        if (csharpSources.Length == 0)
        {
            // The migrated mirror of ourselves. Prove that is what we are
            // looking at — a C#-sourced tree that suddenly has no C# would be a
            // real failure, not an inapplicable claim.
            Assert.NotEmpty(Directory.EnumerateFiles(suite, "*.gs", SearchOption.AllDirectories));
            return;
        }

        StageExecutionContext context = Context();
        foreach (string csFile in csharpSources)
        {
            context.EmittedFiles.Add(new EmittedGsFile(
                Path.GetFileName(csFile), Path.GetFileName(csFile), csFile, string.Empty));
        }

        int declared = TestParityStage.CountCSharpFactMethods(context);
        TimeSpan budget = SdkCompileRunner.MirroredTestRunTimeoutFor(declared);

        Assert.True(declared > 2000, $"only {declared} [Fact] methods counted in Cs2Gs.Tests.");
        Assert.True(
            budget > SdkCompileRunner.MirroredTestRunTimeout,
            $"Cs2Gs.Tests ({declared} tests) still gets only {budget}.");
    }

    private static StageExecutionContext Context()
    {
        string dir = Path.Combine(
            AppContext.BaseDirectory, "issue-3501-budget", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        string projectPath = Path.Combine(dir, "Own.Tests.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
            </Project>
            """);

        var app = new CorpusApp("test/Own.Tests", projectPath, TargetKind.Library);
        var options = new PipelineOptions { OutputRoot = dir };
        var triage = new TriageBuilder("run_1", "2026-09-08T00:00:00Z", "0.0.0", app.Id);
        return new StageExecutionContext(app, options, new GscInvoker("gsc.dll"), dir, triage);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "build")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir.FullName;
    }
}
