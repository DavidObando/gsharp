// <copyright file="TestParityStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 4 (ADR-0115 §C/§E): prove the migrated program behaves identically to
/// the original C# against the captured parity oracle. Two modes, selected by
/// the corpus app:
/// <list type="bullet">
/// <item><description>
/// <b>Executable apps with a stdout golden</b> (e.g. L1) → <b>stdout parity</b>:
/// run the stage-2/3 emitted assembly (<c>dotnet &lt;emitted&gt;.dll</c>),
/// capture stdout, and compare it to <c>baseline.stdout.golden</c> (normalizing
/// the trailing newline only). A mismatch yields a <c>test-parity-failure</c>
/// artifact (<c>STDOUT-MISMATCH</c>).
/// </description></item>
/// <item><description>
/// <b>Library apps with a <c>.Tests</c> oracle</b> (L2/L3) → <b>xUnit
/// pass/fail-set parity</b>: translate the C# <c>.Tests</c> project to a G# xUnit
/// project, build it against the locally-built <c>Gsharp.NET.Sdk</c>, run
/// <c>dotnet test</c>, parse the TRX, and compare the outcome set to
/// <c>baseline.tests.json</c>. Any missing/extra/outcome-mismatch test yields a
/// <c>test-parity-failure</c> artifact. The library path depends on
/// C#-xUnit-test → G# translation (the <i>map-advanced</i> step); until a test
/// project translates cleanly the stage <b>skips the library path with an
/// explicit, recorded reason</b> rather than fabricating a pass.
/// </description></item>
/// </list>
/// Runs only after a green stage-3 (it short-circuits with the rest), so L2/L3
/// — which stop at stage 1 today — never reach it until they translate.
/// </summary>
public sealed class TestParityStage : IMigrationStage
{
    private readonly GsharpTestProjectRunner libraryRunner;

    /// <summary>
    /// Initializes a new instance of the <see cref="TestParityStage"/> class.
    /// </summary>
    /// <param name="libraryRunner">
    /// The live library xUnit runner; when <see langword="null"/> a default
    /// runner that discovers the repo root is used.
    /// </param>
    public TestParityStage(GsharpTestProjectRunner libraryRunner = null)
    {
        this.libraryRunner = libraryRunner ?? new GsharpTestProjectRunner();
    }

    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.TestParity;

    /// <inheritdoc/>
    public async Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        if (IsStdoutEligible(context))
        {
            return this.RunStdoutParity(context);
        }

        if (IsLibraryEligible(context))
        {
            return await this.RunLibraryParityAsync(context, cancellationToken).ConfigureAwait(false);
        }

        if (context.Options.OutputLayout == MigrationOutputLayout.Repository &&
            (context.IsTestProject || IsTestProject(context.App.ProjectPath)))
        {
            return this.RunMirroredTestProject(context);
        }

        // No parity oracle applies to this app (e.g. an executable with no golden
        // or a library with no `.Tests` baseline): nothing to verify.
        this.Note(context, "no parity oracle (no stdout golden and no .Tests baseline); nothing to verify.");
        return StageOutcome.Passed();
    }

    /// <summary>
    /// Issue #2867: detects the VSTest run summary that only ever appears once
    /// the test project has built and its tests have actually executed.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <returns><see langword="true"/> when a test run completed.</returns>
    internal static bool CompletedTestRun(string output)
    {
        return !string.IsNullOrEmpty(output)
            && Regex.IsMatch(
                output,
                @"^\s*(Passed|Failed)!\s+-\s+Failed:",
                RegexOptions.Multiline | RegexOptions.CultureInvariant);
    }

    /// <summary>
    /// Issue #3869: the number of test cases the VSTest run summary reports as
    /// having actually EXECUTED, summed across every summary line (one per
    /// target framework / test assembly), or <see langword="null"/> when the
    /// output carries no run summary at all — i.e. no test run ever happened.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <returns>The executed test-case total, or <see langword="null"/> if no run summary is present.</returns>
    internal static int? ExecutedTestCount(string output)
    {
        if (string.IsNullOrEmpty(output))
        {
            return null;
        }

        MatchCollection matches = Regex.Matches(
            output,
            @"^\s*(?:Passed|Failed)!\s+-\s+Failed:.*?\bTotal:\s*(\d+)",
            RegexOptions.Multiline | RegexOptions.CultureInvariant);
        if (matches.Count == 0)
        {
            return null;
        }

        int total = 0;
        foreach (Match match in matches)
        {
            total += int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
        }

        return total;
    }

    /// <summary>
    /// Issue #3869: decides whether an exit-code-0 <c>dotnet test</c> run on a
    /// mirrored test project is genuinely green.
    /// <para>
    /// <c>dotnet test</c> exits <b>0</b> when it discovers no tests at all — so
    /// an assembly that cannot even be enumerated (e.g. a
    /// <c>TypeLoadException</c> out of <c>GetExportedTypes()</c>, as when a
    /// translator drops the <c>ref</c> from a <c>ref struct</c>) reports
    /// "test-parity PASS" while running ZERO tests. Passing on the exit code
    /// alone makes every future assembly-discovery defect turn the whole app
    /// green: the #1831 class, one stage further along.
    /// </para>
    /// <para>
    /// A green mirrored run must therefore show positive evidence that tests
    /// RAN: a VSTest run summary, a non-zero executed count, and — so a
    /// <i>silent</i> coverage drop is caught too — at least as many executed
    /// cases as the original C# project has <c>[Fact]</c>-attributed test
    /// methods. Only <c>[Fact]</c> is counted (never <c>[Theory]</c>, whose row
    /// count is a runtime property of its data source), which makes
    /// <paramref name="minimumExpected"/> a sound lower bound on the number of
    /// discovered cases rather than a tuned threshold.
    /// </para>
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <param name="minimumExpected">
    /// The lower bound on executed cases derived from the original C# sources
    /// (see <see cref="CountCSharpFactMethods"/>); 0 disables the comparison.
    /// </param>
    /// <returns>
    /// <see langword="null"/> when the run is genuinely green, otherwise the
    /// human-readable reason it is not.
    /// </returns>
    internal static string DescribeHollowTestRun(string output, int minimumExpected)
    {
        int? executed = ExecutedTestCount(output);
        if (executed is null)
        {
            return "NO-TESTS-RAN: `dotnet test` exited 0 but produced no VSTest run summary — " +
                "no test run completed. `dotnet test` exits 0 when it discovers nothing " +
                "(e.g. the migrated assembly fails to type-load and xunit enumerates no types), " +
                "so exit code 0 alone is not evidence of a passing suite (#3869).";
        }

        if (executed.Value == 0)
        {
            return "NO-TESTS-RAN: `dotnet test` exited 0 having executed 0 test cases. " +
                "A zero-test run is not a pass (#3869).";
        }

        if (minimumExpected > 0 && executed.Value < minimumExpected)
        {
            return $"TEST-COVERAGE-DROP: only {executed.Value} test case(s) executed, but the " +
                $"original C# project declares {minimumExpected} [Fact] test method(s) — each of " +
                "which is exactly one test case. Tests were silently lost between the C# original " +
                "and the migrated assembly (#3869).";
        }

        return null;
    }

    /// <summary>
    /// Issue #3869: counts the <c>[Fact]</c>-attributed test methods declared by
    /// the ORIGINAL C# sources of this app — the authoritative lower bound on how
    /// many test cases the migrated assembly must run. The inputs are the exact
    /// C# files the translator consumed for THIS project
    /// (<see cref="EmittedGsFile.CsFilePath"/>, excluding files pulled in from a
    /// referenced project), so the count can never drift from what was migrated.
    /// <para>
    /// Only <c>[Fact]</c> methods in <c>public</c>, concrete, non-generic,
    /// non-static types are counted (see <see cref="IsDiscoverableTestClass"/>):
    /// a <c>[Theory]</c>'s case count is a property of its data source, xunit
    /// does not discover non-public test classes, an abstract type contributes
    /// cases only through its derivations, and a generic test class only through
    /// its closures — counting any of those would make the bound unsound and
    /// manufacture false failures on legitimately green apps.
    /// </para>
    /// </summary>
    /// <param name="context">The stage context.</param>
    /// <returns>The number of <c>[Fact]</c> test methods, or 0 when none can be determined.</returns>
    internal static int CountCSharpFactMethods(StageExecutionContext context)
    {
        var counted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int facts = 0;
        foreach (EmittedGsFile file in context.EmittedFiles)
        {
            if (file.IsFromReferencedProject ||
                string.IsNullOrEmpty(file.CsFilePath) ||
                !counted.Add(file.CsFilePath) ||
                !File.Exists(file.CsFilePath))
            {
                continue;
            }

            string source;
            try
            {
                source = File.ReadAllText(file.CsFilePath);
            }
            catch (IOException)
            {
                // The bound is best-effort evidence, never a reason to crash the
                // stage: an unreadable input simply contributes nothing.
                continue;
            }

            facts += CountFactMethods(source);
        }

        return facts;
    }

    /// <summary>
    /// Issue #3869: the verdict half of <see cref="RunMirroredTestProject"/>,
    /// split from the process invocation so BOTH directions of the gate — a
    /// hollow run must fail, a genuinely green run must still pass — are
    /// testable at stage-outcome level without shelling out to
    /// <c>dotnet test</c>.
    /// </summary>
    /// <param name="context">The stage context.</param>
    /// <param name="result">The captured <c>dotnet test</c> result.</param>
    /// <returns>The stage outcome.</returns>
    internal StageOutcome EvaluateMirroredTestRun(
        StageExecutionContext context, ProcessRunResult result)
    {
        this.Note(context, result.Output ?? string.Empty);
        TestParityAllowList allowList = context.Options.TestParityAllowList ?? TestParityAllowList.Empty;
        if (result.ExitCode == 0)
        {
            // Issue #3869: exit code 0 is NOT evidence that tests ran. `dotnet
            // test` exits 0 when it discovers nothing, so a migrated assembly
            // that cannot be enumerated at all scored a full green here. Require
            // positive evidence instead: a completed run, a non-zero executed
            // count, and no silent drop against the C# original's [Fact] count.
            int minimumExpected = CountCSharpFactMethods(context);
            string hollow = DescribeHollowTestRun(result.Output ?? string.Empty, minimumExpected);
            if (hollow is null)
            {
                string ranNote = $"mirrored test run: {ExecutedTestCount(result.Output)} case(s) executed " +
                    $"(>= {minimumExpected} expected from the C# original's [Fact] methods).";
                this.Note(context, ranNote);

                // Issue #3885: an app whose tests ALL pass still has to answer
                // for its allow-list entries. Without this, the only run in
                // which a stale entry could surface is one that is failing for
                // other reasons — and the list would never shrink.
                this.RecordAllowList(
                    context, allowList.Evaluate(context.App.Id, Array.Empty<string>()));
                return StageOutcome.Passed();
            }

            this.Note(context, "mirrored test-parity FAILED: " + hollow);
            return StageOutcome.Failed(new[]
            {
                context.Triage.TestParityNoTestsRan(
                    hollow, result.Output ?? string.Empty, EmittedGsRelative(context)),
            });
        }

        // Issue #2867: a non-zero `dotnet test` exit means EITHER the project
        // failed to build OR it built, ran, and the tests failed. Only the
        // former is a translator/SDK regression; conflating them sends triage
        // after the emitter when the real signal is a runtime failure, and
        // discards the per-test outcomes.
        string output = result.Output ?? "dotnet test failed without output.";

        // Issue #3931: a run KILLED on the wall-clock budget is a third
        // outcome, and it looked exactly like the first — no summary line, so
        // `CompletedTestRun` is false and it was filed as a build failure.
        // That made a hang indistinguishable from a translator regression, and
        // (worse) let the truncated `[FAIL]` list be read as a parity count
        // when it is only "the failures that happened before the kill". Name
        // the timeout for what it is, ahead of both other classifications.
        if (result.TimedOut)
        {
            return StageOutcome.Failed(new[]
            {
                context.Triage.TestParityLibraryTestRunTimedOut(
                    SdkCompileRunner.MirroredTestRunTimeout, output, EmittedGsRelative(context)),
            });
        }

        if (!CompletedTestRun(output))
        {
            return StageOutcome.Failed(new[]
            {
                context.Triage.TestParityLibraryBuildFailure(output, EmittedGsRelative(context)),
            });
        }

        if (this.AllowListAbsolves(context, allowList, output))
        {
            return StageOutcome.Passed();
        }

        return StageOutcome.Failed(new[]
        {
            context.Triage.TestParityLibraryTestFailure(output, EmittedGsRelative(context)),
        });
    }

    /// <summary>
    /// Issue #3885: whether every failure this completed run reported is on the
    /// allow-list, in which case the app is green despite a non-zero
    /// <c>dotnet test</c> exit.
    /// <para>
    /// The bar is deliberately higher than "the names I could parse are all
    /// allowed". Three things must hold together, and each guards a way this
    /// mechanism could quietly become a licence to pass:
    /// </para>
    /// <list type="number">
    /// <item><description>
    /// The parsed failure names must ACCOUNT FOR every failure the run summary
    /// counts. If the console output names fewer failures than
    /// <c>Failed: N</c> reports, some failure is unaccounted for and could be
    /// anything; the allow-list is refused rather than trusted.
    /// </description></item>
    /// <item><description>
    /// The unallowed set must be EMPTY. "Some failures were allowed" is not the
    /// test; "the failing set is a subset of the allowed set" is.
    /// </description></item>
    /// <item><description>
    /// The #3872/#3869 evidence that tests actually RAN still applies verbatim.
    /// An allow-list entry excuses a test that fails, never a suite that never
    /// executed: an app running zero tests fails whatever is on the list.
    /// </description></item>
    /// </list>
    /// </summary>
    /// <param name="context">The stage context.</param>
    /// <param name="allowList">The loaded allow-list.</param>
    /// <param name="output">The captured <c>dotnet test</c> output of a completed run.</param>
    /// <returns><see langword="true"/> when the app may be reported green.</returns>
    private bool AllowListAbsolves(
        StageExecutionContext context, TestParityAllowList allowList, string output)
    {
        IReadOnlyList<string> failed = TestParityAllowList.ParseFailedTestNames(output);
        TestParityAllowListVerdict verdict = allowList.Evaluate(context.App.Id, failed);
        this.RecordAllowList(context, verdict);

        if (verdict.AllowedFailures.Count == 0)
        {
            return false;
        }

        int reported = TestParityAllowList.ReportedFailureCount(output);
        if (failed.Count != reported)
        {
            string unaccounted =
                $"test-parity allow-list REFUSED: parsed {failed.Count} per-test failure name(s) " +
                $"but the run summary reports {reported} failure(s). An unaccounted-for failure " +
                "could be anything, so the app fails (#3885).";
            this.Note(context, unaccounted);
            return false;
        }

        if (verdict.UnallowedFailures.Count > 0)
        {
            string unlisted = string.Join(Environment.NewLine + "  ", verdict.UnallowedFailures);
            string header = $"test-parity allow-list NOT APPLIED — " +
                $"{verdict.UnallowedFailures.Count} failure(s) are not on the list (#3885):";
            this.Note(context, header + Environment.NewLine + "  " + unlisted);
            return false;
        }

        // The #3872 guard is NOT waived by an allow-list. A suite that failed to
        // run its tests must still fail even when the failures it did report are
        // all allowed.
        int minimumExpected = CountCSharpFactMethods(context);
        string hollow = DescribeHollowTestRun(output, minimumExpected);
        if (hollow is not null)
        {
            string neverRan =
                "test-parity allow-list REFUSED: the run does not show tests actually " +
                "executing, which an allow-list never waives (#3872/#3869): " + hollow;
            this.Note(context, neverRan);
            return false;
        }

        string passedNote =
            $"mirrored test-parity PASSED with {verdict.AllowedFailures.Count} ALLOW-LISTED " +
            $"failure(s) and no others; {ExecutedTestCount(output)} case(s) executed " +
            $"(>= {minimumExpected} expected from the C# original's [Fact] methods) (#3885).";
        this.Note(context, passedNote);
        return true;
    }

    /// <summary>
    /// Issue #3885 requirement 3 — report, never hide. Both halves of the
    /// verdict are written to the stage log AND published on the context so the
    /// run record (and through it the gate summary) names every allow-listed
    /// failure that occurred, and every entry that no longer fires.
    /// </summary>
    /// <param name="context">The stage context.</param>
    /// <param name="verdict">The allow-list verdict.</param>
    private void RecordAllowList(StageExecutionContext context, TestParityAllowListVerdict verdict)
    {
        foreach (string allowed in verdict.AllowedFailures)
        {
            context.AllowedTestFailures.Add(allowed);
            this.Note(context, "test-parity allow-listed failure: " + allowed);
        }

        foreach (TestParityAllowListEntry stale in verdict.StaleEntries)
        {
            // Advisory, never fatal (see TestParityAllowListVerdict.StaleEntries):
            // a hard failure here would make the PR that FIXES a test red.
            context.StaleTestAllowListEntries.Add(stale.ToString());
            string staleNote =
                "test-parity allow-list entry is STALE — no longer failing, remove from the " +
                "allow-list: " + stale;
            this.Note(context, staleNote);
        }
    }

    private static int CountFactMethods(string source)
    {
        Microsoft.CodeAnalysis.CSharp.Syntax.CompilationUnitSyntax root =
            Microsoft.CodeAnalysis.CSharp.SyntaxFactory.ParseCompilationUnit(source);
        return root.DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax>()
            .Count(method =>
                HasFactAttribute(method) &&
                method.Ancestors()
                    .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax>()
                    .All(IsDiscoverableTestClass));
    }

    /// <summary>
    /// Whether a containing type declaration can itself host xunit-discoverable
    /// test cases. Every condition here EXCLUDES cases from the bound, never adds
    /// them: xunit only discovers tests on <c>public</c> classes, an abstract
    /// type contributes cases only through its derivations, and a generic test
    /// class only through its closures. Anything uncertain is left uncounted so
    /// the bound stays a bound.
    /// </summary>
    private static bool IsDiscoverableTestClass(
        Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax type) =>
        type.TypeParameterList is null &&
        type.Modifiers.Any(m => m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PublicKeyword)) &&
        !type.Modifiers.Any(m => m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AbstractKeyword)) &&
        !type.Modifiers.Any(m => m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword));

    private static bool HasFactAttribute(Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax method) =>
        method.AttributeLists
            .SelectMany(list => list.Attributes)
            .Select(attribute => attribute.Name.ToString())
            .Select(name => name.Contains('.') ? name.Substring(name.LastIndexOf('.') + 1) : name)
            .Any(name =>
                string.Equals(name, "Fact", StringComparison.Ordinal) ||
                string.Equals(name, "FactAttribute", StringComparison.Ordinal));

    private static bool IsStdoutEligible(StageExecutionContext context) =>
        context.App.TargetKind == TargetKind.Exe &&
        !string.IsNullOrEmpty(context.App.StdoutGolden) &&
        File.Exists(context.App.StdoutGolden) &&
        !string.IsNullOrEmpty(context.EmittedAssemblyPath) &&
        File.Exists(context.EmittedAssemblyPath);

    private static bool IsLibraryEligible(StageExecutionContext context) =>
        !string.IsNullOrEmpty(context.App.TestsProjectPath) &&
        File.Exists(context.App.TestsProjectPath) &&
        !string.IsNullOrEmpty(context.App.TestsBaselinePath) &&
        File.Exists(context.App.TestsBaselinePath);

    private StageOutcome RunMirroredTestProject(StageExecutionContext context)
    {
        string generatedProject =
            context.Options.GeneratedProjectPaths[Path.GetFullPath(context.App.ProjectPath)];
        ProcessRunResult result = SdkCompileRunner.TestMirroredProject(
            generatedProject,
            context.ArtifactDir,
            context.Options.Config,
            context.Options.GeneratedProjectPaths);
        return this.EvaluateMirroredTestRun(context, result);
    }

    private static bool IsTestProject(string projectPath)
    {
        XDocument project = XDocument.Load(projectPath);
        bool declaredTestProject = project.Descendants()
            .Where(element => element.Name.LocalName.Equals(
                "IsTestProject", StringComparison.OrdinalIgnoreCase))
            .Any(element => string.Equals(element.Value.Trim(), "true", StringComparison.OrdinalIgnoreCase));
        bool testPackage = project.Descendants()
            .Where(element => element.Name.LocalName.Equals(
                "PackageReference", StringComparison.OrdinalIgnoreCase))
            .Select(element => element.Attributes().FirstOrDefault(attribute =>
                attribute.Name.LocalName.Equals("Include", StringComparison.OrdinalIgnoreCase))?.Value)
            .Any(package => string.Equals(
                package, "Microsoft.NET.Test.Sdk", StringComparison.OrdinalIgnoreCase));
        string projectName = Path.GetFileNameWithoutExtension(projectPath);
        string[] segments = Path.GetFullPath(projectPath).Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
            StringSplitOptions.RemoveEmptyEntries);
        return declaredTestProject ||
            testPackage ||
            projectName.EndsWith(".Tests", StringComparison.OrdinalIgnoreCase) ||
            projectName.EndsWith(".Test", StringComparison.OrdinalIgnoreCase) ||
            segments.Any(segment =>
                segment.Equals("tests", StringComparison.OrdinalIgnoreCase) ||
                segment.Equals("test", StringComparison.OrdinalIgnoreCase));
    }

    private StageOutcome RunStdoutParity(StageExecutionContext context)
    {
        (int exit, string stdout, string stderr, bool timedOut) =
            RunProgram(context.EmittedAssemblyPath, context.ProjectOutputDir);

        StdoutParityResult parity = StdoutParity.CompareFile(context.App.StdoutGolden, stdout);

        string note = $"stdout parity: exit={exit}; match={parity.IsMatch}; timedOut={timedOut}." +
            (parity.IsMatch ? string.Empty : " " + parity.Describe()) +
            (string.IsNullOrWhiteSpace(stderr) ? string.Empty : "\nstderr:\n" + stderr);
        this.Note(context, note);

        if (timedOut)
        {
            // A codegen bug producing an infinite loop must surface as a named
            // parity failure, not an unattended-CI hang (#1748).
            StdoutParityResult timeoutDiff = StdoutParityResult.Mismatch(
                0, "process to complete", "process timed out");
            TriageArtifact timeoutArtifact = context.Triage.TestParityStdoutFailure(
                timeoutDiff, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { timeoutArtifact });
        }

        if (parity.IsMatch && exit == 0)
        {
            return StageOutcome.Passed();
        }

        if (parity.IsMatch && exit != 0)
        {
            // Output matched but the process exited non-zero — still a behavioral
            // divergence from the (green) C# baseline. Report it as a stdout-shape
            // failure carrying the exit code.
            StdoutParityResult exitDiff = StdoutParityResult.Mismatch(
                0, "exit code 0", "exit code " + exit);
            TriageArtifact exitArtifact = context.Triage.TestParityStdoutFailure(
                exitDiff, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { exitArtifact });
        }

        TriageArtifact artifact = context.Triage.TestParityStdoutFailure(parity, EmittedGsRelative(context));
        return StageOutcome.Failed(new[] { artifact });
    }

    private async Task<StageOutcome> RunLibraryParityAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken)
    {
        // Translate the C# `.Tests` project to G#. Until C#-xUnit-test → G#
        // translation (map-advanced) is complete, an unsupported construct or a
        // round-trip failure means the live library path cannot run yet; the
        // stage records the reason and skips rather than fabricating a pass.
        TranslatedProject tests = await TranslateProjectAsync(
            context.App.TestsProjectPath, cancellationToken).ConfigureAwait(false);

        if (tests.LoadErrors is not null)
        {
            this.Note(context, "library xUnit parity FAILED: .Tests project did not load.");
            TriageArtifact loadArtifact = context.Triage.ProjectLoadFailure(
                MigrationStageKind.TestParity,
                TriageCategory.TestParityFailure,
                tests.LoadErrors);
            return StageOutcome.Failed(new[] { loadArtifact });
        }

        // Issue #2321: a benign NuGet audit vulnerability advisory (CS2GS0003)
        // never fails the .Tests project load above, but must not be dropped
        // silently either — record it regardless of whether translation below
        // is Ready or (still) Pending.
        foreach (Diagnostic advisory in tests.AdvisoryDiagnostics)
        {
            this.Note(context, "NuGet audit advisory (CS2GS0003, non-fatal) in .Tests project: " + advisory.GetMessage());
        }

        if (tests.PendingReason is not null)
        {
            // Gated intentionally (ADR-0115 §E) until test-translation lands —
            // "not verified yet", never a fabricated pass (issue #1749).
            this.Note(context, "library xUnit parity SKIPPED: " + tests.PendingReason);
            return StageOutcome.Skipped();
        }

        BaselineTestsOracle oracle = BaselineTestsOracle.Load(context.App.TestsBaselinePath);

        string libraryName = context.Options.OutputLayout == MigrationOutputLayout.Repository
            ? Path.GetFileNameWithoutExtension(context.App.ProjectPath)
            : MigrationPipeline.SanitizeAppId(context.App.Id).Replace("corpus_", string.Empty);
        var project = new GsharpTestProject
        {
            LibraryName = libraryName,
            LibraryRootNamespace = libraryName.Replace('-', '_'),
            LibraryFiles = context.EmittedFiles
                .Select(f => new GsharpSourceFile(Path.GetFileName(f.GsPath), f.GSharpSource))
                .ToList(),
            LibraryFriendAssemblies =
                context.Options.OutputLayout == MigrationOutputLayout.Repository
                    ? context.GeneratedFriendAssemblies.OrderBy(name => name, StringComparer.Ordinal).ToList()
                    : Array.Empty<string>(),
            TestsName = libraryName + ".Tests",
            TestsRootNamespace = libraryName.Replace('-', '_') + ".Tests",
            TestFiles = tests.Files,
        };

        string workDir = Path.Combine(context.ArtifactDir, "test-parity");
        GsharpTestRunResult run = this.libraryRunner.Run(project, workDir);

        if (run.Status == GsharpTestRunStatus.Unavailable)
        {
            // The SDK/tooling this verification needs is genuinely absent (no
            // locally-built Gsharp.NET.Sdk nupkg) — "not verified", not a pass
            // (issue #1749 mode 1).
            this.Note(context, "library xUnit parity SKIPPED: " + run.UnavailableReason);
            return StageOutcome.Skipped();
        }

        if (run.Status == GsharpTestRunStatus.BuildFailed)
        {
            // A library that green-built standalone `gsc` in stage 2 but fails
            // to build its translated G# test project here is a real
            // regression, not "translation pending" — report it as a failure
            // (issue #1749 mode 1), never a fabricated pass.
            string buildNote = "library xUnit parity FAILED: the translated G# test project did not build.\n" +
                Truncate(run.Output);
            this.Note(context, buildNote);
            TriageArtifact buildArtifact = context.Triage.TestParityLibraryBuildFailure(
                run.Output, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { buildArtifact });
        }

        TestParityResult parity = TestParityComparison.Compare(oracle.Tests, run.Results);
        string parityNote = $"library xUnit parity: {run.Results.Count} ran vs {oracle.Tests.Count} baseline; " +
            $"match={parity.IsMatch}; diffs={parity.Differences.Count}.";
        this.Note(context, parityNote);

        if (parity.IsMatch)
        {
            return StageOutcome.Passed();
        }

        string gsFile = tests.Files.Count > 0 ? project.TestsName + "/" + tests.Files[0].FileName : null;
        var artifacts = parity.Differences
            .Select(diff => context.Triage.TestParityTestFailure(diff, gsFile))
            .ToList();
        return StageOutcome.Failed(artifacts);
    }

    private static async Task<TranslatedProject> TranslateProjectAsync(
        string projectPath,
        CancellationToken cancellationToken)
    {
        LoadedCSharpProject project = await CSharpProjectLoader
            .LoadProjectAsync(projectPath, cancellationToken)
            .ConfigureAwait(false);

        // Issue #1742: same load-failure gate as TranslateStage, scoped to the
        // MSBuild workspace load failure signal (not every C# semantic error —
        // some corpus fixtures deliberately carry those to exercise a later
        // stage). A `.Tests` project that does not bind in C# must fail the
        // stage, not be silently skipped as "translation pending" nor proceed
        // to translate.
        if (project.WorkspaceLoadFailed)
        {
            return TranslatedProject.LoadFailed(project.WorkspaceLoadErrors);
        }

        // Issue #2321: a benign NuGet audit vulnerability advisory (CS2GS0003)
        // does not fail the workspace load gate above; carry it forward to the
        // caller so it can be recorded (not silently dropped) regardless of
        // whether translation below ends up Ready or Pending.
        List<Diagnostic> advisoryDiagnostics = project.LoadDiagnostics
            .Where(d => d.Id == CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId)
            .ToList();

        var files = new List<GsharpSourceFile>();
        var usedGsFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Issue #2292: ONE translator instance shared across every document in
        // this project (rather than a fresh one per file) so its package-scoped
        // anonymous-type registry (see `CSharpToGSharpTranslator.
        // anonymousTypeRegistriesByPackage`) is shared too — otherwise two
        // files in the same package could each mint a colliding
        // `AnonymousTypeN` name for two DIFFERENT anonymous shapes (GS0102).
        var translator = new CSharpToGSharpTranslator(preservePartialParts: true);
        foreach (LoadedDocument document in project.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var translationContext = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);

            CompilationUnit unit = translator.TranslateDocument(document, translationContext);
            string printed = GSharpPrinter.Print(unit);

            TranslationDiagnostic unsupported = translationContext.Diagnostics
                .FirstOrDefault(d => d.Severity == TranslationSeverity.Unsupported);
            if (unsupported is not null)
            {
                return TranslatedProject.Pending(
                    $"test-translation pending map-advanced — unsupported C# construct " +
                    $"'{unsupported.ConstructKind}' in {Path.GetFileName(document.FilePath)}: {unsupported.Message}",
                    advisoryDiagnostics);
            }

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
            if (!roundTrip.Success)
            {
                return TranslatedProject.Pending(
                    $"test-translation pending map-advanced — emitted G# for " +
                    $"{Path.GetFileName(document.FilePath)} did not round-trip-parse: " +
                    (roundTrip.Errors.FirstOrDefault() ?? "unknown parse error"),
                    advisoryDiagnostics);
            }

            string gsFileName = EmittedFileNaming.UniqueGsFileName(document.FilePath, usedGsFileNames);
            files.Add(new GsharpSourceFile(gsFileName, printed));
        }

        return TranslatedProject.Ready(files, advisoryDiagnostics);
    }

    private static (int Exit, string Stdout, string Stderr, bool TimedOut) RunProgram(string assemblyPath, string workingDirectory)
    {
        // The migrated program under test is exactly the code stage 4 exists to
        // scrutinize: a codegen bug can produce an infinite loop, and a
        // translated Console.ReadLine() would otherwise block on inherited
        // stdin. ProcessRunner bounds the run and never inherits stdin (#1748).
        ProcessRunResult result = ProcessRunner.Run(
            "dotnet", new[] { assemblyPath }, workingDirectory, Stage4Timeout());
        return (result.ExitCode, result.Stdout, result.Stderr, result.TimedOut);
    }

    /// <summary>
    /// The stage-4 program-under-test timeout, 30s by default. A legit slow
    /// migrated program on a cold/constrained CI runner can false-positive
    /// against a fixed 30s, so allow an override via
    /// <c>CS2GS_STAGE4_TIMEOUT_SEC</c> (#1817 S1).
    /// </summary>
    private static TimeSpan Stage4Timeout()
    {
        string env = Environment.GetEnvironmentVariable("CS2GS_STAGE4_TIMEOUT_SEC");
        return int.TryParse(env, out int seconds) && seconds > 0
            ? TimeSpan.FromSeconds(seconds)
            : TimeSpan.FromSeconds(30);
    }

    private static string EmittedGsRelative(StageExecutionContext context) =>
        context.EmittedFiles.Count > 0 ? context.EmittedFiles[0].RelativeGsPath : null;

    private static string Truncate(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= 2000 ? trimmed : trimmed.Substring(trimmed.Length - 2000);
    }

    private void Note(StageExecutionContext context, string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(context.ArtifactDir, "test-parity.log"),
                message + Environment.NewLine);
        }
        catch (IOException)
        {
            // A best-effort diagnostic log; never fail the stage on a log write.
        }
    }

    private sealed class TranslatedProject
    {
        private TranslatedProject(
            IReadOnlyList<GsharpSourceFile> files,
            string pendingReason,
            IReadOnlyList<Diagnostic> loadErrors,
            IReadOnlyList<Diagnostic> advisoryDiagnostics)
        {
            this.Files = files ?? Array.Empty<GsharpSourceFile>();
            this.PendingReason = pendingReason;
            this.LoadErrors = loadErrors;
            this.AdvisoryDiagnostics = advisoryDiagnostics ?? Array.Empty<Diagnostic>();
        }

        public IReadOnlyList<GsharpSourceFile> Files { get; }

        public string PendingReason { get; }

        /// <summary>Gets the load-error diagnostics, or <see langword="null"/> if the project bound.</summary>
        public IReadOnlyList<Diagnostic> LoadErrors { get; }

        /// <summary>
        /// Gets the benign NuGet audit vulnerability advisories (issue #2321,
        /// <see cref="CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId"/>,
        /// CS2GS0003) MSBuildWorkspace reported while opening this project.
        /// Always empty for a <see cref="LoadFailed"/> project.
        /// </summary>
        public IReadOnlyList<Diagnostic> AdvisoryDiagnostics { get; }

        public static TranslatedProject Ready(IReadOnlyList<GsharpSourceFile> files, IReadOnlyList<Diagnostic> advisoryDiagnostics) =>
            new TranslatedProject(files, null, null, advisoryDiagnostics);

        public static TranslatedProject Pending(string reason, IReadOnlyList<Diagnostic> advisoryDiagnostics) =>
            new TranslatedProject(Array.Empty<GsharpSourceFile>(), reason, null, advisoryDiagnostics);

        public static TranslatedProject LoadFailed(IReadOnlyList<Diagnostic> loadErrors) =>
            new TranslatedProject(Array.Empty<GsharpSourceFile>(), null, loadErrors, null);
    }
}
