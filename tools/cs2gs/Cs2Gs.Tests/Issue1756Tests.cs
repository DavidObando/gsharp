// <copyright file="Issue1756Tests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Report;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1756's low-severity CLI/report polish batch:
/// verb-level <c>--help</c> exiting 0, a missing option value exiting 1 with
/// usage (not the internal-error exit 2), <see cref="HtmlReportWriter"/>
/// slug collisions producing distinct/matching anchors, and the
/// <see cref="AppReport"/>/<see cref="Cs2Gs.Pipeline.AppResult"/> JSON shape
/// staying byte-identical after collapsing the duplicated report types. Also
/// covers #1854, a follow-up that narrows the missing-option-value catch to a
/// dedicated sentinel exception type (kept in this class/collection so its
/// <see cref="Console"/>-swapping <c>RunMainAsync</c> helper isn't run
/// concurrently with another test class's copy of the same pattern).
/// </summary>
public class Issue1756Tests
{
    /// <summary>
    /// <c>cs2gs migrate --help</c> and <c>cs2gs report --help</c> (and
    /// <c>-h</c>) must print usage and exit 0, not be treated as an unknown
    /// option (which would exit 1).
    /// </summary>
    [Theory]
    [InlineData("migrate", "--help")]
    [InlineData("migrate", "-h")]
    [InlineData("report", "--help")]
    [InlineData("report", "-h")]
    public async Task VerbHelp_ExitsZero_AndPrintsUsage(string verb, string helpFlag)
    {
        (int exitCode, string stdout, string stderr) = await RunMainAsync(verb, helpFlag);

        Assert.Equal(0, exitCode);
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal);
        Assert.Empty(stderr);
    }

    /// <summary>
    /// A flag that requires a value but is given none (e.g. <c>--gsc</c> as
    /// the last token) must exit 1 with usage text, the same as an unknown
    /// option — not exit 2 (the internal-error code), which must stay
    /// reserved for genuine internal errors.
    /// </summary>
    [Theory]
    [InlineData("migrate", "--gsc")]
    [InlineData("migrate", "--corpus")]
    [InlineData("report", "--run")]
    public async Task MissingOptionValue_ExitsOne_WithUsage_NotInternalError(string verb, string flag)
    {
        (int exitCode, string stdout, string stderr) = await RunMainAsync(verb, flag);

        Assert.Equal(1, exitCode);
        Assert.Contains("requires a value", stderr, StringComparison.Ordinal);
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>NextValue</c> must throw a dedicated sentinel type (a private
    /// nested subclass of <see cref="ArgumentException"/>), not a plain
    /// <see cref="ArgumentException"/> — see issue #1854. This is what lets
    /// the verb loops' catch clauses narrow to exactly the missing-value
    /// case: catching the sentinel type by name, rather than
    /// <see cref="ArgumentException"/> itself, means any other
    /// <see cref="ArgumentException"/> a case body might throw (e.g. a future
    /// validating option setter) is not caught here and falls through to
    /// exit 2.
    /// </summary>
    [Fact]
    public void NextValue_MissingValue_ThrowsSentinelType_NotBaseArgumentException()
    {
        System.Reflection.MethodInfo nextValue = typeof(Cs2Gs.Cli.Program).GetMethod(
            "NextValue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(nextValue);

        var args = new[] { "--gsc" };
        object[] parameters = { args, 0, "--gsc" };

        var wrapper = Assert.Throws<System.Reflection.TargetInvocationException>(
            () => nextValue.Invoke(null, parameters));
        Exception thrown = wrapper.InnerException;

        Assert.IsAssignableFrom<ArgumentException>(thrown);
        Assert.NotEqual(typeof(ArgumentException), thrown.GetType());
        Assert.Equal("MissingOptionValueException", thrown.GetType().Name);
    }

    /// <summary>
    /// An unknown option (e.g. <c>--bogus</c>) must still exit 1 with usage
    /// for both verbs, unchanged by the #1854 sentinel-narrowing fix —
    /// unknown options are detected by the <c>default:</c> switch arm, not by
    /// <c>NextValue</c>, so they never go through the narrowed catch at all.
    /// </summary>
    [Theory]
    [InlineData("migrate", "--bogus")]
    [InlineData("report", "--bogus")]
    public async Task UnknownOption_ExitsOne_WithUsage(string verb, string flag)
    {
        (int exitCode, string stdout, string stderr) = await RunMainAsync(verb, flag);

        Assert.Equal(1, exitCode);
        Assert.Contains("unknown option", stderr, StringComparison.Ordinal);
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal);
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunMainAsync(params string[] args)
    {
        TextWriter originalOut = Console.Out;
        TextWriter originalError = Console.Error;
        var capturedOut = new StringWriter();
        var capturedError = new StringWriter();
        Console.SetOut(capturedOut);
        Console.SetError(capturedError);
        int exitCode;
        try
        {
            exitCode = await Cs2Gs.Cli.Program.Main(args).ConfigureAwait(false);
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
        }

        return (exitCode, capturedOut.ToString(), capturedError.ToString());
    }

    /// <summary>
    /// Three app ids that all fold to the same <c>Slug</c> under
    /// case-folding + non-alphanumeric collapsing must still get distinct
    /// HTML ids, and each matrix row's <c>href="#app-…"</c> must match the
    /// corresponding detail <c>id="app-…"</c> exactly (three-way collision,
    /// generalizing beyond a simple pair).
    /// </summary>
    [Fact]
    public void HtmlReport_ThreeWaySlugCollision_ProducesDistinctIds_WithMatchingAnchors()
    {
        // "corpus/L1-Console", "corpus/l1.console", and "corpus/L1_Console"
        // all fold to the same base slug ("corpus-l1-console").
        var run = new RunResult
        {
            RunId = "run-1756",
            Timestamp = "2026-01-01T00:00:00Z",
            GscVersion = "0.2.0+test",
            Succeeded = true,
            Apps = new List<AppResult>
            {
                MakeApp("corpus/L1-Console"),
                MakeApp("corpus/L1_Console"),
                MakeApp("corpus/l1.console"),
            },
        };

        ReportModel model = ReportModel.Build(run, Directory.GetCurrentDirectory());
        string html = HtmlReportWriter.Render(model);

        // Every rendered id="app-…" must be unique.
        var ids = System.Text.RegularExpressions.Regex.Matches(html, "id=\"(app-[^\"]+)\"")
            .Select(m => m.Groups[1].Value)
            .ToList();
        Assert.Equal(3, ids.Count);
        Assert.Equal(ids.Count, ids.Distinct(StringComparer.Ordinal).Count());

        // Every matrix href="#app-…" must resolve to one of the rendered ids.
        var hrefs = System.Text.RegularExpressions.Regex.Matches(html, "href=\"#(app-[^\"]+)\"")
            .Select(m => m.Groups[1].Value)
            .ToList();
        Assert.Equal(3, hrefs.Count);
        foreach (string href in hrefs)
        {
            Assert.Contains(href, ids);
        }

        // Same model rendered twice is byte-identical (deterministic slugs).
        Assert.Equal(html, HtmlReportWriter.Render(model));
    }

    private static AppResult MakeApp(string appId)
    {
        return new AppResult
        {
            AppId = appId,
            Succeeded = true,
            Stages = new List<StageResult>
            {
                new StageResult { Stage = "translate", Status = "passed" },
                new StageResult { Stage = "compile", Status = "passed" },
                new StageResult { Stage = "ilverify", Status = "passed" },
                new StageResult { Stage = "test-parity", Status = "passed" },
            },
        };
    }

    /// <summary>
    /// Golden: the <c>summary.json</c> shape for <see cref="AppReport"/>
    /// (now reusing <see cref="Cs2Gs.Pipeline.StageResult"/> for its
    /// <c>stages</c> list instead of a byte-identical, hand-duplicated
    /// <c>StageReport</c> type) must stay exactly what it was before the
    /// collapse: same property names, order, and values, per app/stage.
    /// </summary>
    [Fact]
    public void JsonSummary_AppAndStageShape_IsByteIdenticalGolden()
    {
        var run = new RunResult
        {
            RunId = "run-1756-golden",
            Timestamp = "2026-01-01T00:00:00Z",
            GscVersion = "0.2.0+test",
            Succeeded = true,
            Apps = new List<AppResult>
            {
                new AppResult
                {
                    AppId = "corpus/L1-Console",
                    Succeeded = true,
                    Stages = new List<StageResult>
                    {
                        new StageResult { Stage = "translate", Status = "passed", ArtifactCount = 0 },
                        new StageResult { Stage = "compile", Status = "passed", ArtifactCount = 0 },
                        new StageResult { Stage = "ilverify", Status = "passed", ArtifactCount = 0 },
                        new StageResult { Stage = "test-parity", Status = "passed", ArtifactCount = 0 },
                    },
                    Artifacts = new List<string>(),
                    Fingerprints = new List<string>(),
                },
            },
        };

        ReportModel model = ReportModel.Build(run, Directory.GetCurrentDirectory());
        string json = JsonSummaryWriter.Serialize(model);

        using var doc = JsonDocument.Parse(json);
        JsonElement app = doc.RootElement.GetProperty("apps")[0];

        // Exact property set + order for the app row (extended for issue
        // #1831 with "unverified", inserted right after "succeeded").
        Assert.Equal(
            new[] { "appId", "succeeded", "unverified", "failureCategory", "stages", "artifacts", "fingerprints" },
            app.EnumerateObject().Select(p => p.Name).ToArray());

        JsonElement stage = app.GetProperty("stages")[0];

        // Exact property set + order for each stage row — the shape that
        // used to live on the now-removed, hand-duplicated StageReport type.
        Assert.Equal(
            new[] { "stage", "status", "artifactCount" },
            stage.EnumerateObject().Select(p => p.Name).ToArray());
        Assert.Equal("translate", stage.GetProperty("stage").GetString());
        Assert.Equal("passed", stage.GetProperty("status").GetString());
        Assert.Equal(0, stage.GetProperty("artifactCount").GetInt32());
    }
}
