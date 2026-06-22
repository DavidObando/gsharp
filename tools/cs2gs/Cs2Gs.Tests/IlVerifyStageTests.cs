// <copyright file="IlVerifyStageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for stage 3 (ADR-0115 §C/§D): the <c>ilverify</c> output parser, the
/// <c>ilverify-failure</c> triage artifact shape and fingerprint, the documented
/// false-positive ignore bundle, and the L1-Console end-to-end gate (which must
/// pass IL verification cleanly). The L1 path is gated on the <c>gsc</c> artifact
/// and the <c>dotnet-ilverify</c> tool being present, returning early otherwise
/// like the other e2e tests.
/// </summary>
public class IlVerifyStageTests
{
    private const string SampleErrorLine =
        "[IL]: Error [StackUnexpected]: [/abs/App.dll : Program::Main(string[])]" +
        "[offset 0x00000001] Unexpected type on the stack.";

    /// <summary>
    /// The parser extracts the ilverify error code and the failing
    /// <c>Type::Method(sig)</c> skeleton from a canonical error line, and ignores
    /// non-error banner/summary lines.
    /// </summary>
    [Fact]
    public void ParseErrors_ExtractsCodeAndMethod_SkipsNoise()
    {
        string output = string.Join(
            "\n",
            "All Classes and Methods in /abs/App.dll Verified.",
            SampleErrorLine,
            "Error(s): 1");

        IReadOnlyList<IlVerifyError> errors = IlVerifyRunner.ParseErrors(output);

        IlVerifyError error = Assert.Single(errors);
        Assert.Equal("StackUnexpected", error.Code);
        Assert.Equal("Program::Main(string[])", error.Method);
        Assert.Contains("Unexpected type on the stack.", error.RawLine);
    }

    /// <summary>
    /// An <c>ilverify-failure</c> artifact built from a parsed error carries the
    /// stage/category, a non-empty diagnostic id parsed from the line, labels
    /// <c>Oats</c> + <c>cil-emit</c>, and a stable <c>sha256:</c> fingerprint.
    /// </summary>
    [Fact]
    public void IlVerifyFailureArtifact_HasShapeAndCilEmitLabel()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        IlVerifyError error = Assert.Single(IlVerifyRunner.ParseErrors(SampleErrorLine));

        TriageArtifact artifact = builder.IlVerifyFailure(error, "corpus_Sample/Sample.gs");
        string json = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        Assert.Equal("ilverify", root.GetProperty("stage").GetString());
        Assert.Equal("ilverify-failure", root.GetProperty("category").GetString());
        Assert.Equal("StackUnexpected", root.GetProperty("diagnostic").GetProperty("id").GetString());
        Assert.Equal("error", root.GetProperty("diagnostic").GetProperty("severity").GetString());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("diagnostic").GetProperty("message").GetString()));
        Assert.Equal(
            "Program::Main(string[])",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString());

        string[] labels = root.GetProperty("suggestedIssue").GetProperty("labels")
            .EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("Oats", labels);
        Assert.Contains("cil-emit", labels);

        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// The fingerprint splits on distinct error code and on distinct failing
    /// method, so the pipeline produces one artifact per code + method skeleton.
    /// </summary>
    [Fact]
    public void IlVerifyFailure_Fingerprint_SplitsOnCodeAndMethod()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");

        TriageArtifact a = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"));
        TriageArtifact sameAgain = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"));
        TriageArtifact differentCode = builder.IlVerifyFailure(
            new IlVerifyError("ReturnVoid", "Program::Main(string[])", "line a"));
        TriageArtifact differentMethod = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Helper(int32)", "line a"));

        Assert.Equal(a.Fingerprint, sameAgain.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentCode.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentMethod.Fingerprint);
    }

    /// <summary>
    /// The documented ilverify 10.0.8 false positives — <c>ReturnPtrToStack</c>
    /// (by-value ref-struct returns) and the static-virtual
    /// <c>CallAbstract</c>/<c>Constrained</c> bundle (ADR-0089 / #755) — are
    /// declared in the ignore set and filtered out so they never yield artifacts,
    /// while a genuine error survives.
    /// </summary>
    [Fact]
    public void IgnoreBundle_FiltersKnownFalsePositives_KeepsRealErrors()
    {
        Assert.Contains("ReturnPtrToStack", IlVerifyRunner.KnownIlVerifyFalsePositives);
        Assert.Contains("CallAbstract", IlVerifyRunner.KnownIlVerifyFalsePositives);
        Assert.Contains("Constrained", IlVerifyRunner.KnownIlVerifyFalsePositives);

        var errors = new[]
        {
            new IlVerifyError("ReturnPtrToStack", "Acc::Add(Acc, int32)", "fp 1"),
            new IlVerifyError("Constrained", "P::Sum<T>(T[])", "fp 2"),
            new IlVerifyError("CallAbstract", "P::Sum<T>(T[])", "fp 3"),
            new IlVerifyError("StackUnexpected", "P::Main(string[])", "real"),
        };

        IReadOnlyList<IlVerifyError> filtered = IlVerifyRunner.FilterIgnored(errors);

        IlVerifyError surviving = Assert.Single(filtered);
        Assert.Equal("StackUnexpected", surviving.Code);
    }

    /// <summary>
    /// Running the pipeline over <c>corpus/L1-Console</c> passes stage 3
    /// (<c>ilverify</c>) cleanly with zero artifacts: all three stages green and
    /// the stage list now has three entries. Gated on the compiler artifact and
    /// the ilverify tool being present.
    /// </summary>
    [Fact]
    public async Task L1_StageThree_IsGreen_WithZeroArtifacts()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l1-ilverify-green");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "L1 must migrate green through stage 3 (ilverify). Failure category: " +
                (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
        Assert.Empty(app.Artifacts);
        Assert.Equal(3, app.Stages.Count);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
        Assert.Equal("ilverify", app.Stages[2].Stage);
    }

    private static bool IlVerifyToolAvailable()
    {
        if (!IlVerifyRunner.IsEnabled)
        {
            // GSHARP_SKIP_ILVERIFY=1: the stage no-ops to PASS, so the green
            // assertion still holds.
            return true;
        }

        try
        {
            var runner = new IlVerifyRunner();
            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = runner.RepoRoot,
            };
            foreach (string arg in new[] { "tool", "run", "ilverify", "--version" })
            {
                psi.ArgumentList.Add(arg);
            }

            using var proc = System.Diagnostics.Process.Start(psi);
            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode == 0)
            {
                return true;
            }

            // Try a one-time restore, then re-probe.
            var restore = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = runner.RepoRoot,
            };
            foreach (string arg in new[] { "tool", "restore" })
            {
                restore.ArgumentList.Add(arg);
            }

            using var rp = System.Diagnostics.Process.Start(restore);
            rp.StandardOutput.ReadToEnd();
            rp.StandardError.ReadToEnd();
            rp.WaitForExit();
            return rp.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}
