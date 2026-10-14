// <copyright file="Issue1756Tests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import Cs2Gs.Report
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.Json
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1756's low-severity CLI/report polish batch:
/// verb-level `--help` exiting 0, a missing option value exiting 1 with
/// usage (not the internal-error exit 2), (cref:HtmlReportWriter)
/// slug collisions producing distinct/matching anchors, and the
/// (cref:AppReport)/(cref:Cs2Gs.Pipeline.AppResult) JSON shape
/// staying byte-identical after collapsing the duplicated report types. Also
/// covers #1854, a follow-up that narrows the missing-option-value catch to a
/// dedicated sentinel exception type (kept in this class/collection so its
/// (cref:Console)-swapping `RunMainAsync` helper isn't run
/// concurrently with another test class's copy of the same pattern).
open class Issue1756Tests {
    /// `cs2gs migrate --help` and `cs2gs report --help` (and
    /// `-h`) must print usage and exit 0, not be treated as an unknown
    /// option (which would exit 1).
    @Theory
    @InlineData("migrate", "--help")
    @InlineData("migrate", "-h")
    @InlineData("report", "--help")
    @InlineData("report", "-h")
    async func VerbHelp_ExitsZero_AndPrintsUsage(verb string, helpFlag string) {
        let (exitCode, stdout, stderr) = await RunMainAsync(verb, helpFlag)
        Assert.Equal(0, exitCode)
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal)
        Assert.Empty(stderr)
    }

    /// A flag that requires a value but is given none (e.g. `--gsc` as
    /// the last token) must exit 1 with usage text, the same as an unknown
    /// option — not exit 2 (the internal-error code), which must stay
    /// reserved for genuine internal errors.
    @Theory
    @InlineData("migrate", "--gsc")
    @InlineData("migrate", "--corpus")
    @InlineData("report", "--run")
    async func MissingOptionValue_ExitsOne_WithUsage_NotInternalError(verb string, flag string) {
        let (exitCode, stdout, stderr) = await RunMainAsync(verb, flag)
        Assert.Equal(1, exitCode)
        Assert.Contains("requires a value", stderr, StringComparison.Ordinal)
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal)
    }

    @Fact
    async func Migrate_RepositoryModeRequiresOutputDirectory() {
        let (exitCode, stdout, stderr) = await RunMainAsync("migrate", "--corpus", ".")
        Assert.Equal(1, exitCode)
        Assert.Empty(stdout)
        Assert.Contains("requires --out", stderr, StringComparison.Ordinal)
    }

    @Fact
    async func Migrate_RepositoryModeRejectsPartialAppSelection() {
        let (exitCode, stdout, stderr) = await RunMainAsync(
            "migrate",
            "--corpus",
            ".",
            "--out",
            "unused",
            "--app",
            "Sample"
        )
        Assert.Equal(1, exitCode)
        Assert.Empty(stdout)
        Assert.Contains("--diagnostic-run", stderr, StringComparison.Ordinal)
    }

    /// `NextValue` must throw a dedicated sentinel type (a private
    /// nested subclass of (cref:ArgumentException)), not a plain
    /// (cref:ArgumentException) — see issue #1854. This is what lets
    /// the verb loops' catch clauses narrow to exactly the missing-value
    /// case: catching the sentinel type by name, rather than
    /// (cref:ArgumentException) itself, means any other
    /// (cref:ArgumentException) a case body might throw (e.g. a future
    /// validating option setter) is not caught here and falls through to
    /// exit 2.
    @Fact
    func NextValue_MissingValue_ThrowsSentinelType_NotBaseArgumentException() {
        let nextValue MethodInfo? = typeof(Program).GetMethod("NextValue", BindingFlags.NonPublic | BindingFlags.Static)
        Assert.NotNull(nextValue)
        let args = []string{"--gsc"}
        let parameters[]object = []object{args, 0, "--gsc"}
        let wrapper = Assert.Throws[TargetInvocationException](
            func () object? {
                return nextValue!!.Invoke(nil, parameters)
            }
        )
        let thrown Exception? = wrapper.InnerException
        Assert.IsAssignableFrom[ArgumentException](thrown)
        Assert.NotEqual(typeof(ArgumentException), thrown!!.GetType())
        Assert.Equal("MissingOptionValueException", thrown!!.GetType().Name)
    }

    /// An unknown option (e.g. `--bogus`) must still exit 1 with usage
    /// for both verbs, unchanged by the #1854 sentinel-narrowing fix —
    /// unknown options are detected by the `default:` switch arm, not by
    /// `NextValue`, so they never go through the narrowed catch at all.
    @Theory
    @InlineData("migrate", "--bogus")
    @InlineData("report", "--bogus")
    async func UnknownOption_ExitsOne_WithUsage(verb string, flag string) {
        let (exitCode, stdout, stderr) = await RunMainAsync(verb, flag)
        Assert.Equal(1, exitCode)
        Assert.Contains("unknown option", stderr, StringComparison.Ordinal)
        Assert.Contains("Usage:", stdout, StringComparison.Ordinal)
    }

    /// Three app ids that all fold to the same `Slug` under
    /// case-folding + non-alphanumeric collapsing must still get distinct
    /// HTML ids, and each matrix row's `href="#app-…"` must match the
    /// corresponding detail `id="app-…"` exactly (three-way collision,
    /// generalizing beyond a simple pair).
    @Fact
    func HtmlReport_ThreeWaySlugCollision_ProducesDistinctIds_WithMatchingAnchors() {
        // "corpus/L1-Console", "corpus/l1.console", and "corpus/L1_Console"
        // all fold to the same base slug ("corpus-l1-console").
        let run = RunResult{
            RunId: "run-1756",
            Timestamp: "2026-01-01T00:00:00Z",
            GscVersion: "0.2.0+test",
            Succeeded: true,
            Apps: List[AppResult]{
                MakeApp("corpus/L1-Console"),
                MakeApp("corpus/L1_Console"),
                MakeApp("corpus/l1.console")
            }
        }
        let model = ReportModel.Build(run, Directory.GetCurrentDirectory())
        let html = HtmlReportWriter.Render(model)
        // Every rendered id="app-…" must be unique.
        let ids = Regex.Matches(html, "id=\"(app-[^\"]+)\"").Select((m Match) -> m.Groups[1].Value).ToList()
        Assert.Equal(3, ids.Count)
        Assert.Equal(ids.Count, ids.Distinct(StringComparer.Ordinal).Count())
        // Every matrix href="#app-…" must resolve to one of the rendered ids.
        let hrefs = Regex.Matches(html, "href=\"#(app-[^\"]+)\"").Select((m Match) -> m.Groups[1].Value).ToList()
        Assert.Equal(3, hrefs.Count)
        for href in hrefs {
            Assert.Contains(href, ids)
        }
        // Same model rendered twice is byte-identical (deterministic slugs).
        Assert.Equal(html, HtmlReportWriter.Render(model))
    }

    /// Golden: the `summary.json` shape for (cref:AppReport)
    /// (now reusing (cref:Cs2Gs.Pipeline.StageResult) for its
    /// `stages` list instead of a byte-identical, hand-duplicated
    /// `StageReport` type) must stay exactly what it was before the
    /// collapse: same property names, order, and values, per app/stage.
    @Fact
    func JsonSummary_AppAndStageShape_IsByteIdenticalGolden() {
        let run = RunResult{
            RunId: "run-1756-golden",
            Timestamp: "2026-01-01T00:00:00Z",
            GscVersion: "0.2.0+test",
            Succeeded: true,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/L1-Console",
                    Succeeded: true,
                    Stages: List[StageResult]{
                        StageResult{Stage: "translate", Status: "passed", ArtifactCount: 0},
                        StageResult{Stage: "compile", Status: "passed", ArtifactCount: 0},
                        StageResult{Stage: "ilverify", Status: "passed", ArtifactCount: 0},
                        StageResult{Stage: "test-parity", Status: "passed", ArtifactCount: 0}
                    },
                    Artifacts: List[string](),
                    Fingerprints: List[string]()
                }
            }
        }
        let model = ReportModel.Build(run, Directory.GetCurrentDirectory())
        let json = JsonSummaryWriter.Serialize(model)
        using let doc = JsonDocument.Parse(json)
        let app = doc.RootElement.GetProperty("apps")[0]
        // Exact property set + order for the app row (extended for issue
        // #1831 with "unverified", inserted right after "succeeded").
        Assert.Equal(
            []string{"appId", "succeeded", "unverified", "failureCategory", "stages", "artifacts", "fingerprints"},
            app.EnumerateObject().Select((p JsonProperty) -> p.Name).ToArray()
        )
        let stage = app.GetProperty("stages")[0]
        // Exact property set + order for each stage row — the shape that
        // used to live on the now-removed, hand-duplicated StageReport type.
        Assert.Equal(
            []string{"stage", "status", "artifactCount"},
            stage.EnumerateObject().Select((p JsonProperty) -> p.Name).ToArray()
        )
        Assert.Equal("translate", stage.GetProperty("stage").GetString())
        Assert.Equal("passed", stage.GetProperty("status").GetString())
        Assert.Equal(0, stage.GetProperty("artifactCount").GetInt32())
    }

    shared {
        private async func RunMainAsync(args ...string)(ExitCode int32, Stdout string, Stderr string) {
            let originalOut = Console.Out
            let originalError = Console.Error
            let capturedOut = StringWriter()
            let capturedError = StringWriter()
            Console.SetOut(capturedOut)
            Console.SetError(capturedError)
            var exitCode int32
            try {
                exitCode = await Program.Main(args).ConfigureAwait(false)
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            return (exitCode, capturedOut.ToString(), capturedError.ToString())
        }

        private func MakeApp(appId string) AppResult {
            return AppResult{
                AppId: appId,
                Succeeded: true,
                Stages: List[StageResult]{
                    StageResult{Stage: "translate", Status: "passed"},
                    StageResult{Stage: "compile", Status: "passed"},
                    StageResult{Stage: "ilverify", Status: "passed"},
                    StageResult{Stage: "test-parity", Status: "passed"}
                }
            }
        }
    }
}
