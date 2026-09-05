// <copyright file="Issue3931KilledTestRunClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3931: a mirrored <c>dotnet test</c> run that is KILLED on the
/// wall-clock budget produces no run summary — only the partial <c>[FAIL]</c>
/// list printed before the kill. That output has exactly the shape of a
/// project that never built, so the stage filed it as
/// <c>LIBRARY-BUILD-FAILED</c>: a hang and a translator regression looked
/// identical, and the truncated <c>[FAIL]</c> list read as a parity count when
/// it is only "the failures that happened first". Both halves are proved here:
/// a killed run must be named a timeout, and a genuine build failure must
/// still be named a build failure.
/// </summary>
public sealed class Issue3931KilledTestRunClassificationTests
{
    /// <summary>
    /// The captured shape of a killed run: some `[FAIL]` lines, then
    /// ProcessRunner's kill notice — and no `Failed! … Total: N` anywhere.
    /// </summary>
    private const string KilledRunOutput = """
        [xUnit.net 00:00:05.01]     ChainedMemberAccess_ResolvesInnerSegment [FAIL]
        [xUnit.net 00:02:50.09]     OpenChangeAndSave_PushMode_PublishFullBindingDiagnostics [FAIL]

        [ProcessRunner] 'dotnet' timed out after 00:10:00 and was killed.
        """;

    private const string BuildFailureOutput = """
        Determining projects to restore...
        /tmp/migrated/Own.Tests/Own.gs(3,1): error GS0157: Cannot find type Nope.
        """;

    [Fact]
    public void KilledRun_IsNamedATimeout_NotABuildFailure()
    {
        StageExecutionContext context = Context();

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(-1, KilledRunOutput, string.Empty, true));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-TIMED-OUT");
        Assert.DoesNotContain(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-BUILD-FAILED");

        // The artifact must SAY the output is truncated, so a reader cannot
        // mistake the surviving [FAIL] lines for a parity count.
        Assert.Contains(
            "TRUNCATED",
            Assert.Single(outcome.Artifacts).Diagnostic.Message,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The other direction: a run that really did fail to build — no summary
    /// line, but also no kill — must keep its <c>LIBRARY-BUILD-FAILED</c>
    /// classification. Without this, the timeout branch could have been
    /// written to swallow every summary-less run.
    /// </summary>
    [Fact]
    public void GenuineBuildFailure_StillNamedABuildFailure()
    {
        StageExecutionContext context = Context();

        StageOutcome outcome = new TestParityStage().EvaluateMirroredTestRun(
            context, new ProcessRunResult(1, BuildFailureOutput, string.Empty, false));

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Contains(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-BUILD-FAILED");
        Assert.DoesNotContain(outcome.Artifacts, a => a.Diagnostic.Id == "LIBRARY-TESTS-TIMED-OUT");
    }

    private static StageExecutionContext Context()
    {
        string dir = Path.Combine(
            AppContext.BaseDirectory, "issue-3931-killed-run", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        string csPath = Path.Combine(dir, "Own.cs");
        File.WriteAllText(csPath, "using Xunit; public class Own { [Fact] public void A() { } }");

        string projectPath = Path.Combine(dir, "Own.Tests.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
            </Project>
            """);

        var app = new CorpusApp("test/Own.Tests", projectPath, TargetKind.Library);
        var options = new PipelineOptions { OutputRoot = dir };
        var triage = new TriageBuilder("run_1", "2026-09-05T00:00:00Z", "0.0.0", app.Id);
        var context = new StageExecutionContext(app, options, new GscInvoker(FindCompiler()), dir, triage);
        context.EmittedFiles.Add(new EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty));
        return context;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return "gsc.dll";
    }
}
