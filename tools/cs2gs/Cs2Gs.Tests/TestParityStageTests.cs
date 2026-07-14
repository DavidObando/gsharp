// <copyright file="TestParityStageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// End-to-end tests for stage 4 (ADR-0115 §C/§E) over the real <c>L1-Console</c>
/// corpus app: the stdout-parity GREEN path (L1 is the first app green across all
/// four stages) and the stdout-mismatch capture path (a deliberately-wrong golden
/// yields a <c>test-parity-failure</c> artifact). Both gate on the <c>gsc</c>
/// compiler artifact being present, returning early otherwise like the other
/// pipeline e2e tests.
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public class TestParityStageTests
{
    /// <summary>
    /// Running the pipeline over <c>corpus/L1-Console</c> passes all FOUR stages —
    /// translate, compile, ilverify, AND test-parity (stdout matches the golden) —
    /// with zero artifacts. This is the milestone: L1 is green end-to-end.
    /// </summary>
    [Fact]
    public async Task L1_AllFourStages_AreGreen_WithStdoutParity()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l1-testparity-green");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "L1 must migrate green through stage 4 (test-parity). Failure category: " +
                (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
        Assert.Empty(app.Artifacts);
        Assert.Equal(4, app.Stages.Count);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
        Assert.Equal("test-parity", app.Stages[3].Stage);
    }

    /// <summary>
    /// When the migrated program's stdout diverges from the golden, stage 4 yields
    /// a single <c>test-parity-failure</c> artifact with the <c>STDOUT-MISMATCH</c>
    /// diagnostic id, labels <c>Oats</c> + <c>bug</c>, and a stable <c>sha256:</c>
    /// fingerprint. Exercised by pointing L1 at a deliberately-wrong golden copy.
    /// </summary>
    [Fact]
    public async Task L1_WrongGolden_ProducesTestParityFailureArtifact()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        CorpusApp original = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(original);

        string outRoot = NewOutputRoot("l1-testparity-mismatch");
        string wrongGolden = Path.Combine(outRoot, "wrong.stdout.golden");
        File.WriteAllText(wrongGolden, "this is definitely not the real L1 output\n");

        var tampered = new CorpusApp(
            original.Id,
            original.ProjectPath,
            original.TargetKind,
            stdoutGolden: wrongGolden,
            referencedAssemblies: original.ReferencedAssemblies);

        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        RunResult result = await pipeline.RunAsync(new[] { tampered });
        AppResult app = Assert.Single(result.Apps);

        Assert.False(app.Succeeded);
        Assert.Equal("test-parity-failure", app.FailureCategory);

        string[] files = Directory.GetFiles(outRoot, "test-parity-*.json", SearchOption.AllDirectories);
        Assert.NotEmpty(files);

        string match = files.FirstOrDefault(f => File.ReadAllText(f).Contains("STDOUT-MISMATCH"));
        Assert.NotNull(match);

        string json = File.ReadAllText(match);
        Assert.Contains("test-parity-failure", json);
        Assert.Contains("\"Oats\"", json);
        Assert.Contains("\"bug\"", json);
        Assert.Contains("sha256:", json);
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
