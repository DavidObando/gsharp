// <copyright file="Issue3869ZeroTestFalseGreenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Issue #3869 defect 2 (the gate hole, and the more important half): the
/// mirrored test-parity path used to pass on `result.ExitCode == 0` ALONE.
/// `dotnet test` exits 0 when it discovers no tests, so a migrated assembly
/// that cannot even be enumerated — `GetExportedTypes()` throwing
/// `TypeLoadException`, xunit finding nothing — scored
/// `test-parity PASS` while running ZERO tests. Any future
/// assembly-discovery defect would have turned a whole app green the same way:
/// the #1831 class, one stage further along.
///
/// The guard is proved in BOTH directions here. A gate that only ever fails is
/// as useless as one that only ever passes, so the legitimately-green runs below
/// are as load-bearing as the hollow ones.
class Issue3869ZeroTestFalseGreenTests {
    /// The #3869 repro itself: `dotnet test` exited 0 having discovered nothing.
    /// This must FAIL, not pass.
    @Fact
    func DiscoveryFailure_ExitZero_IsNotGreen() {
        let reason = TestParityStage.DescribeHollowTestRun(TypeLoadFailureOutput, minimumExpected: 0)!!
        Assert.NotNull(reason)
        Assert.Contains("NO-TESTS-RAN", reason, StringComparison.Ordinal)
    }

    /// A run summary that reports zero executed cases is likewise not a pass —
    /// the summary line existing is not the same as tests having run.
    @Fact
    func ZeroExecutedCases_IsNotGreen() {
        let reason = TestParityStage.DescribeHollowTestRun(
            "Passed!  - Failed:     0, Passed:     0, Skipped:     0, Total:     0, Duration: 1 ms - X.dll (net10.0)",
            minimumExpected: 0
        )!!
        Assert.NotNull(reason)
        Assert.Contains("NO-TESTS-RAN", reason, StringComparison.Ordinal)
    }

    /// Empty output (the process produced nothing at all) is not evidence of a
    /// passing suite either.
    @Fact
    func NoOutput_IsNotGreen() {
        Assert.NotNull(TestParityStage.DescribeHollowTestRun(string.Empty, minimumExpected: 0))
    }

    /// THE OTHER DIRECTION. A genuinely-passing run must still pass — otherwise
    /// the fix has merely broken the gate the opposite way.
    @Fact
    func GenuineGreenRun_StillPasses() {
        Assert.Null(TestParityStage.DescribeHollowTestRun(GreenRunOutput, minimumExpected: 0))
        Assert.Null(TestParityStage.DescribeHollowTestRun(GreenRunOutput, minimumExpected: 248))
        Assert.Null(TestParityStage.DescribeHollowTestRun(GreenRunOutput, minimumExpected: 100))
    }

    /// A multi-assembly / multi-TFM run reports one summary line per assembly;
    /// the executed cases are the SUM, not the first line, so a legitimately
    /// green two-assembly run must not be failed for "too few" tests.
    @Fact
    func MultipleSummaryLines_AreSummed() {
        let output = `Passed!  - Failed:     0, Passed:   120, Skipped:     1, Total:   121, Duration: 2 s - A.dll (net10.0)
Passed!  - Failed:     0, Passed:   130, Skipped:     0, Total:   130, Duration: 3 s - B.dll (net10.0)`
        Assert.Equal(251, TestParityStage.ExecutedTestCount(output))
        Assert.Null(TestParityStage.DescribeHollowTestRun(output, minimumExpected: 251))
    }

    /// A SILENT coverage drop — the run is green, the tests that ran passed, but
    /// materially fewer of them ran than the C# original declares — must fail
    /// too. Exit code 0 plus "some tests ran" is still not parity.
    @Fact
    func SilentCoverageDrop_IsNotGreen() {
        let reason = TestParityStage.DescribeHollowTestRun(GreenRunOutput, minimumExpected: 400)!!
        Assert.NotNull(reason)
        Assert.Contains("TEST-COVERAGE-DROP", reason, StringComparison.Ordinal)
        Assert.Contains("248", reason, StringComparison.Ordinal)
        Assert.Contains("400", reason, StringComparison.Ordinal)
    }

    /// The lower bound counts only `[Fact]` methods in public, concrete,
    /// non-generic, non-static types. A `[Theory]`'s case count is a
    /// property of its data source, xunit never discovers a non-public test
    /// class, an abstract type contributes cases only through derivations, and a
    /// generic test class only through closures — counting any of those would
    /// make the bound unsound and manufacture false failures on legitimately
    /// green apps. Every exclusion here can only LOWER the bound, which is the
    /// direction that keeps a green app green.
    @Fact
    func FactCount_IsASoundLowerBound() {
        let context = ContextWithCSharpSource(`using Xunit;

public class Concrete
{
    [Fact] public void A() { }
    [Fact] public void B() { }
    [Xunit.Fact] public void FullyQualified() { }
    [Theory] [InlineData(1)] public void NotCounted(int x) { }
    public void PlainMethod() { }
}

public abstract class AbstractBase
{
    [Fact] public void NotCountedEither() { }
}

public class Generic<T>
{
    [Fact] public void NorThis() { }
}

internal class NotPublic
{
    [Fact] public void XunitNeverDiscoversThis() { }
}

public static class StaticHolder
{
    [Fact] public static void NorThisOne() { }
}`)
        Assert.Equal(3, TestParityStage.CountCSharpFactMethods(context))
    }

    /// Files pulled in from a referenced project belong to another app's count;
    /// counting them here would manufacture a coverage-drop failure.
    @Fact
    func FactCount_IgnoresReferencedProjectFiles() {
        let context = ContextWithCSharpSource("using Xunit; public class Own { [Fact] public void A() { } }")
        let foreignPath = Path.Combine(NewDirectory(), "Foreign.cs")
        File.WriteAllText(
            foreignPath,
            "using Xunit; public class Foreign { [Fact] public void B() { } [Fact] public void C() { } }"
        )
        context.EmittedFiles.Add(
            EmittedGsFile("Foreign.gs", "Foreign.gs", foreignPath, string.Empty){IsFromReferencedProject = true}
        )
        Assert.Equal(1, TestParityStage.CountCSharpFactMethods(context))
    }

    /// A project with no `[Fact]` at all (e.g. all `[Theory]`) yields a
    /// bound of 0, which disables the comparison rather than failing every such
    /// app: the zero-test guard alone still applies.
    @Fact
    func NoFacts_DisablesTheComparison_ButNotTheZeroGuard() {
        let context = ContextWithCSharpSource(
            "using Xunit; public class OnlyTheories { [Theory] [InlineData(1)] public void T(int x) { } }"
        )
        Assert.Equal(0, TestParityStage.CountCSharpFactMethods(context))
        Assert.Null(TestParityStage.DescribeHollowTestRun(GreenRunOutput, minimumExpected: 0))
        Assert.NotNull(TestParityStage.DescribeHollowTestRun(TypeLoadFailureOutput, minimumExpected: 0))
    }

    /// Stage-outcome level, direction 1: the exact #3869 run — `dotnet test`
    /// exit 0, discovery blown up by `TypeLoadException`, zero tests — must
    /// produce a FAILED stage carrying a `NO-TESTS-RAN` artifact. On
    /// `origin/main` this same input returned
    /// (cref:StageStatus.Passed) with no artifacts, which is how
    /// `test/Core.Tests` scored a full green on an assembly that cannot be
    /// enumerated.
    @Fact
    func Stage_HollowRun_Fails() {
        let context = ContextWithCSharpSource("using Xunit; public class Own { [Fact] public void A() { } }")
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, TypeLoadFailureOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.NotEqual(StageStatus.Passed, outcome.Status)
        Assert.NotEqual(StageStatus.Skipped, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "NO-TESTS-RAN")
    }

    /// Stage-outcome level, direction 2 — the half without which the fix would
    /// have made the gate useless the opposite way: a legitimately green run
    /// (tests discovered, executed, all passing, count at or above the C#
    /// original's `[Fact]` bound) must still PASS with no artifacts.
    @Fact
    func Stage_GenuineGreenRun_StillPasses() {
        let context = ContextWithCSharpSource(
            "using Xunit; public class Own { [Fact] public void A() { } [Fact] public void B() { } }"
        )
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(0, GreenRunOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
    }

    /// A non-zero exit still classifies as before (#2867): build failure vs test
    /// failure. The #3869 guard must not have swallowed that distinction.
    @Fact
    func Stage_FailingTests_StillReportAsTestFailure_NotNoTestsRan() {
        let context = ContextWithCSharpSource("using Xunit; public class Own { [Fact] public void A() { } }")
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(
                1,
                "Failed!  - Failed:     2, Passed:   246, Skipped:     0, Total:   248, Duration: 4 s - X.dll (net10.0)",
                string.Empty,
                false
            )
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-FAILED")
        Assert.DoesNotContain(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "NO-TESTS-RAN")
    }

    shared {
        /// The real captured output of the #3869 repro: discovery blew up, exit 0.
        private const TypeLoadFailureOutput string = `Determining projects to restore...
[xUnit.net 00:00:00.08] Exception discovering tests from GSharp.Core.Tests:
System.TypeLoadException: A ByRef or ByRef-like type cannot be used as the type for an instance field in a non-ByRef-like type.
   at System.Reflection.RuntimeAssembly.GetExportedTypes()
   at Xunit.Sdk.ReflectionAssemblyInfo.GetTypes(Boolean includePrivateTypes)
No test is available in /tmp/migrated/GSharp.Core.Tests.dll. Make sure that test discoverer & executors are registered.`

        private const GreenRunOutput string = `Determining projects to restore...
Passed!  - Failed:     0, Passed:   248, Skipped:     0, Total:   248, Duration: 4 s - GSharp.Core.Tests.dll (net10.0)`

        private func ContextWithCSharpSource(source string) StageExecutionContext {
            let dir = NewDirectory()
            let csPath = Path.Combine(dir, "Own.cs")
            File.WriteAllText(csPath, source)
            let projectPath = Path.Combine(dir, "Own.Tests.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
            let app = CorpusApp("test/Own.Tests", projectPath, TargetKind.Library)
            let options = PipelineOptions{OutputRoot: dir}
            let triage = TriageBuilder("run_1", "2026-09-03T00:00:00Z", "0.0.0", app.Id)
            let context = StageExecutionContext(app, options, GscInvoker(FindCompiler()), dir, triage)
            context.EmittedFiles.Add(EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty))
            return context
        }

        private func FindCompiler() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return "gsc.dll"
        }

        private func NewDirectory() string {
            let path = Path.Combine(AppContext.BaseDirectory, "issue-3869-zero-tests", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }
    }
}
