// <copyright file="Issue3723PolishConvergenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3723: the redundant-<c>!!</c> polish loop has to run to a real fixed
/// point. One compile only reports what it managed to bind — it stops at the
/// first project that fails, and a nested assertion only becomes visibly
/// redundant once the one outside it is gone — so a fixed round budget leaves
/// the app red with GS0536 as its only diagnostic. These tests drive
/// <see cref="NullAssertionPolishPass.RunToFixedPoint"/> with a stand-in
/// compiler so the multi-generation and per-project shapes are exercised
/// without a real <c>dotnet build</c>.
/// </summary>
public sealed class Issue3723PolishConvergenceTests
{
    [Fact]
    public void RunToFixedPoint_ConvergesAcrossGenerations_PastTheOldThreeRoundBudget()
    {
        using var workspace = new PolishWorkspace();
        string file = workspace.WriteFile("Nested.gs", "let a = b!!.c!!.d!!.e!!");
        var compiler = new FakeCompiler(workspace.Files, PerLineFrontier);

        NullAssertionPolishPass.PolishLoopOutcome outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(),
            compiler.Compile,
            workspace.Files);

        Assert.False(outcome.CapExhausted);
        Assert.Equal(0, outcome.RemainingReports);
        Assert.Equal(4, outcome.Stripped);

        // Four generations: strictly more than the three rounds the loop used
        // to allow, which is what left the gate's apps red.
        Assert.Equal(4, outcome.Rounds);
        Assert.True(outcome.Result.Succeeded);
        Assert.Equal("let a = b.c.d.e", File.ReadAllText(file).TrimEnd());
    }

    [Fact]
    public void RunToFixedPoint_ConvergesWhenEachCompileOnlyReachesTheNextProject()
    {
        using var workspace = new PolishWorkspace();

        // A compile reports nothing past the project it fails on, so the loop
        // sees one file's worth of assertions at a time however many are left.
        string[] files = Enumerable.Range(1, 5)
            .Select(i => workspace.WriteFile("Project" + i + ".gs", "let a = b!!"))
            .ToArray();
        var compiler = new FakeCompiler(workspace.Files, FirstFileFrontier);

        NullAssertionPolishPass.PolishLoopOutcome outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(),
            compiler.Compile,
            workspace.Files);

        Assert.False(outcome.CapExhausted);
        Assert.Equal(0, outcome.RemainingReports);
        Assert.Equal(5, outcome.Rounds);
        Assert.All(files, f => Assert.Equal("let a = b", File.ReadAllText(f).TrimEnd()));
    }

    [Fact]
    public void RunToFixedPoint_ReportsTheCapInsteadOfGivingUpSilently()
    {
        using var workspace = new PolishWorkspace();
        workspace.WriteFile("Nested.gs", "let a = b!!.c!!.d!!.e!!");
        var compiler = new FakeCompiler(workspace.Files, PerLineFrontier);

        NullAssertionPolishPass.PolishLoopOutcome outcome = NullAssertionPolishPass.RunToFixedPoint(
            compiler.Compile(),
            compiler.Compile,
            workspace.Files,
            strippableRoot: null,
            maxRounds: 2);

        Assert.True(outcome.CapExhausted);
        Assert.Equal(2, outcome.Rounds);
        Assert.Equal(2, outcome.Stripped);
        Assert.True(outcome.RemainingReports > 0);
        Assert.False(outcome.Result.Succeeded);
    }

    [Fact]
    public void RunToFixedPoint_RestoresAnAssertionTheRecompileTurnsOutToNeed()
    {
        using var workspace = new PolishWorkspace();
        string file = workspace.WriteFile("Needed.gs", "let a = b!!");
        const string original = "let a = b!!";

        // The first build passed (GS0536 is advisory there), so the polished
        // build that fails to bind is a regression: the assertion goes back.
        SdkCompileResult initial = SdkCompileResult.Completed(
            0,
            output: null,
            new[] { Diagnostic(NullAssertionPolishPass.DiagnosticId, "warning", file, 1, 10) },
            emittedAssemblyPath: "app.dll");
        var recompiles = 0;
        SdkCompileResult Recompile()
        {
            recompiles++;
            return SdkCompileResult.Completed(
                1,
                output: null,
                new[] { Diagnostic("GS0400", "error", file, 1, 9) },
                emittedAssemblyPath: null);
        }

        NullAssertionPolishPass.PolishLoopOutcome outcome = NullAssertionPolishPass.RunToFixedPoint(
            initial,
            Recompile,
            workspace.Files);

        Assert.Equal(1, recompiles);
        Assert.Equal(1, outcome.Rounds);
        Assert.Same(initial, outcome.Result);
        Assert.Equal(original, File.ReadAllText(file).TrimEnd());
    }

    [Fact]
    public void RunToFixedPoint_StopsWhenNothingReportedCanBeStripped()
    {
        using var workspace = new PolishWorkspace();
        string file = workspace.WriteFile("Stale.gs", "let a = b");
        var recompiles = 0;
        SdkCompileResult Recompile()
        {
            recompiles++;
            return SdkCompileResult.Completed(0, null, Array.Empty<GscDiagnostic>(), "app.dll");
        }

        // A span that no longer holds `!!` is skipped rather than applied, so
        // the loop must end instead of spinning to the cap.
        SdkCompileResult initial = SdkCompileResult.Completed(
            1,
            output: null,
            new[] { Diagnostic(NullAssertionPolishPass.DiagnosticId, "error", file, 1, 10) },
            emittedAssemblyPath: null);

        NullAssertionPolishPass.PolishLoopOutcome outcome = NullAssertionPolishPass.RunToFixedPoint(
            initial,
            Recompile,
            workspace.Files);

        Assert.Equal(0, recompiles);
        Assert.False(outcome.CapExhausted);
        Assert.Equal(1, outcome.Rounds);
        Assert.Equal(0, outcome.Stripped);
        Assert.Equal("let a = b", File.ReadAllText(file).TrimEnd());
    }

    private static GscDiagnostic Diagnostic(string id, string severity, string file, int line, int column) =>
        new GscDiagnostic(id, "Redundant '!!'…", severity, file, line, column, line, column + 2);

    // Reports the leftmost `!!` of every line of every file — the stand-in
    // for gsc reporting one generation at a time: a nested assertion only
    // becomes visibly redundant once the one outside it is gone.
    private static IEnumerable<(string File, int Line, int Column)> PerLineFrontier(
        IReadOnlyList<string> files)
    {
        foreach (string file in files)
        {
            string[] lines = File.ReadAllLines(file);
            for (var i = 0; i < lines.Length; i++)
            {
                int index = lines[i].IndexOf("!!", StringComparison.Ordinal);
                if (index >= 0)
                {
                    yield return (file, i + 1, index + 1);
                }
            }
        }
    }

    // Reports every `!!` of the FIRST file that still has one: the shape of a
    // build that never gets past the project it fails on.
    private static IEnumerable<(string File, int Line, int Column)> FirstFileFrontier(
        IReadOnlyList<string> files)
    {
        foreach (string file in files)
        {
            var reports = new List<(string File, int Line, int Column)>();
            string[] lines = File.ReadAllLines(file);
            for (var i = 0; i < lines.Length; i++)
            {
                for (int index = lines[i].IndexOf("!!", StringComparison.Ordinal);
                    index >= 0;
                    index = lines[i].IndexOf("!!", index + 2, StringComparison.Ordinal))
                {
                    reports.Add((file, i + 1, index + 1));
                }
            }

            if (reports.Count > 0)
            {
                return reports;
            }
        }

        return Array.Empty<(string File, int Line, int Column)>();
    }

    private sealed class FakeCompiler
    {
        private readonly IReadOnlyList<string> files;
        private readonly Func<IReadOnlyList<string>, IEnumerable<(string File, int Line, int Column)>> report;

        public FakeCompiler(
            IReadOnlyList<string> files,
            Func<IReadOnlyList<string>, IEnumerable<(string File, int Line, int Column)>> report)
        {
            this.files = files;
            this.report = report;
        }

        public SdkCompileResult Compile()
        {
            IReadOnlyList<GscDiagnostic> diagnostics = this.report(this.files)
                .Select(r => Diagnostic(NullAssertionPolishPass.DiagnosticId, "error", r.File, r.Line, r.Column))
                .ToList();
            return diagnostics.Count == 0
                ? SdkCompileResult.Completed(0, null, diagnostics, "app.dll")
                : SdkCompileResult.Completed(1, null, diagnostics, null);
        }
    }

    private sealed class PolishWorkspace : IDisposable
    {
        private readonly string directory;
        private readonly List<string> files = new List<string>();

        public PolishWorkspace()
        {
            this.directory = Path.Combine(
                Path.GetTempPath(),
                nameof(Issue3723PolishConvergenceTests),
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.directory);
        }

        public IReadOnlyList<string> Files => this.files;

        public string WriteFile(string name, params string[] lines)
        {
            string path = Path.Combine(this.directory, name);
            File.WriteAllLines(path, lines);
            this.files.Add(path);
            return path;
        }

        public void Dispose()
        {
            if (Directory.Exists(this.directory))
            {
                Directory.Delete(this.directory, recursive: true);
            }
        }
    }
}
