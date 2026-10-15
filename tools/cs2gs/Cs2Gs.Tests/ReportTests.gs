// <copyright file="ReportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import Cs2Gs.Report
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.Json
import System.Text.RegularExpressions
import Xunit

/// Tests for the `Cs2Gs.Report` step (ADR-0115 §F): the
/// (cref:ReportModel) aggregation and fingerprint grouping, the
/// deterministic `summary.json` schema, and the self-contained,
/// HTML-encoded, deterministic `report.html`.
open class ReportTests {
    /// The aggregator collapses the same fingerprint hit by two apps into one
    /// gap with two occurrences, preserves stage order including `skipped`,
    /// and merges/dedups the retry history (ADR-0115 §F/§D.2).
    @Fact
    func ReportModel_GroupsByFingerprint_PreservesStageOrder_MergesRetryHistory() {
        let runDir = WriteSyntheticRun()
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.Equal([]string{"translate", "compile", "ilverify", "test-parity"}, model.StageOrder)
        Assert.Equal(3, model.TotalApps)
        Assert.Equal(1, model.GreenApps)
        Assert.False(model.Succeeded)
        // A failed run is never "unverified" (issue #1831): failed takes
        // precedence over the skipped stages the failing apps also carry.
        Assert.False(model.Unverified)
        Assert.Equal(0, model.UnverifiedApps)
        // Apps sorted by id.
        Assert.Equal(
            []string{"corpus/L1-Console", "corpus/L2-Library", "corpus/L3-Library"},
            model.Apps.Select((a AppReport) -> a.AppId).ToArray()
        )
        // Shared fingerprint collapses to one gap with two occurrences.
        let shared = Assert.Single(model.Gaps, (g GapReport) -> g.Fingerprint == "sha256:shared00aaaa")
        Assert.Equal(
            []string{"corpus/L2-Library", "corpus/L3-Library"},
            shared.Occurrences.Select((o GapOccurrence) -> o.AppId).ToArray()
        )
        // Stage order preserved, skipped stages present after the failing stage.
        let l2 = model.Apps.Single((a AppReport) -> a.AppId == "corpus/L2-Library")
        Assert.Equal(
            []string{"translate", "compile", "ilverify", "test-parity"},
            l2.Stages.Select((s StageResult) -> s.Stage).ToArray()
        )
        Assert.Equal("failed", l2.Stages[0].Status)
        Assert.Equal("skipped", l2.Stages[1].Status)
        Assert.Equal("skipped", l2.Stages[3].Status)
        // Retry history merged + deduped across the two occurrences, sorted by runId.
        Assert.Equal(2, shared.RetryHistory.Count)
        Assert.Equal([]string{"run-a", "run-b"}, shared.RetryHistory.Select((e TriageRetryEntry) -> e.RunId).ToArray())
        // Gaps sorted by fingerprint.
        Assert.Equal(
            model
                .Gaps
                .Select((g GapReport) -> g.Fingerprint)
                .OrderBy((f string) -> f, StringComparer.Ordinal)
                .ToArray(),
            model.Gaps.Select((g GapReport) -> g.Fingerprint).ToArray()
        )
        // Failed run stays red/non-zero exit (issue #1831 must not touch this).
        Assert.Equal(1, Program.DetermineMigrateExitCode(model.Succeeded, reportGenerated: true))
    }

    /// The JSON summary is schema-stable (gaps keyed by fingerprint), and
    /// re-serializing the same model is byte-identical (ADR-0115 §F).
    @Fact
    func JsonSummary_IsKeyedByFingerprint_AndByteStable() {
        let runDir = WriteSyntheticRun()
        let model = ReportModel.FromRunDirectory(runDir)
        let json = JsonSummaryWriter.Serialize(model)
        using let doc = JsonDocument.Parse(json)
        let root = doc.RootElement
        for key in[]string{"runId", "timestamp", "gscVersion", "succeeded", "stageOrder", "apps", "gaps"} {
            Assert.True(root.TryGetProperty(key, out _), "summary missing key '$key'")
        }
        let gaps = root.GetProperty("gaps")
        Assert.All(
            gaps.EnumerateArray(),
            (g JsonElement) -> Assert.False(string.IsNullOrEmpty(g.GetProperty("fingerprint").GetString()))
        )
        Assert.Contains(
            gaps.EnumerateArray(),
            (g JsonElement) -> g.GetProperty("fingerprint").GetString() == "sha256:shared00aaaa" && g.GetProperty(
                "occurrences"
            )
                .GetArrayLength() == 2
        )
        // Byte-stable on re-serialization of an independently-built model.
        let model2 = ReportModel.FromRunDirectory(runDir)
        Assert.Equal(json, JsonSummaryWriter.Serialize(model2))
    }

    /// The HTML report is self-contained (no external asset references) and the
    /// status matrix and gap blocks render (ADR-0115 §F).
    @Fact
    func HtmlReport_IsSelfContained_AndRendersMatrixAndGaps() {
        let runDir = WriteSyntheticRun()
        let model = ReportModel.FromRunDirectory(runDir)
        let html = HtmlReportWriter.Render(model)
        Assert.DoesNotContain("http://", html, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("https://", html, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("<link", html, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("src=", html, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("@import", html, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("<style>", html, StringComparison.Ordinal)
        Assert.Contains("class=\"matrix\"", html, StringComparison.Ordinal)
        Assert.Contains("corpus/L1-Console", html, StringComparison.Ordinal)
        Assert.Contains("aria-label=\"passed\"", html, StringComparison.Ordinal)
        Assert.Contains("aria-label=\"skipped\"", html, StringComparison.Ordinal)
        Assert.Contains("class=\"gap\"", html, StringComparison.Ordinal)
        Assert.Contains("sha256:shared00aaaa", html, StringComparison.Ordinal)
    }

    /// Every interpolated value is HTML-encoded: a gap whose diagnostic message
    /// and snippet carry `<script>`, `&`, and `"`
    /// renders escaped, not as raw markup (ADR-0115 §F security requirement).
    @Fact
    func HtmlReport_HtmlEncodesInjectedMarkup() {
        let runDir = NewRunDir("encode")
        let run = RunResult{
            RunId: "run-x",
            Timestamp: "2026-01-01T00:00:00Z",
            GscVersion: "9.9.9",
            Succeeded: false,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/Evil",
                    Succeeded: false,
                    FailureCategory: "translation-unsupported",
                    Stages: AllStages("failed"),
                    Artifacts: List[string]{"corpus_Evil/translate-evil.json"},
                    Fingerprints: List[string]{"sha256:evil"}
                }
            }
        }
        WriteRunJson(runDir, run)
        let artifact = TriageArtifact{
            RunId: "run-x",
            CorpusAppId: "corpus/Evil",
            Stage: "translate",
            Category: "translation-unsupported",
            Diagnostic: TriageDiagnostic{
                Id: "CS2GS-UNSUPPORTED",
                Message: "<script>alert(\"x&y\")</script>",
                Severity: "error"
            },
            SourceLocation: TriageSourceLocation{CsFile: "Evil.cs"},
            OffendingCSharpConstruct: TriageOffendingConstruct{
                Kind: "Construct",
                Snippet: "var a = b < c && d > \"e\";"
            },
            SuggestedIssue: TriageSuggestedIssue{
                Title: "<b>bad & title</b>",
                Body: "body with <img> & \"quotes\"",
                Labels: List[string]{"Oats"}
            },
            Fingerprint: "sha256:evil"
        }
        WriteArtifact(runDir, "corpus_Evil/translate-evil.json", artifact)
        let model = ReportModel.FromRunDirectory(runDir)
        let html = HtmlReportWriter.Render(model)
        Assert.DoesNotContain("<script>alert", html, StringComparison.Ordinal)
        Assert.DoesNotContain("<b>bad & title</b>", html, StringComparison.Ordinal)
        Assert.DoesNotContain("<img>", html, StringComparison.Ordinal)
        Assert.Contains("&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;", html, StringComparison.Ordinal)
        Assert.Contains("&lt;b&gt;bad &amp; title&lt;/b&gt;", html, StringComparison.Ordinal)
    }

    /// Issue #4918: a compile error raised while building a dependency project
    /// carries a line and column but neither a C# nor a G# file (the diagnostic
    /// did not resolve to an emitted .gs). The report must still render the
    /// failed run, with the occurrence listed and no location, instead of
    /// crashing with a NullReferenceException and leaving the run without a
    /// report.
    @Fact
    func HtmlReport_OccurrenceWithLineButNoFile_RendersWithoutLocation() {
        let runDir = NewRunDir("no-file")
        let run = RunResult{
            RunId: "run-y",
            Timestamp: "2026-01-01T00:00:00Z",
            GscVersion: "9.9.9",
            Succeeded: false,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "src/Dependent",
                    Succeeded: false,
                    FailureCategory: "compile-error",
                    Stages: AllStages("failed"),
                    Artifacts: List[string]{"src_Dependent/compile-nofile.json"},
                    Fingerprints: List[string]{"sha256:nofile"}
                }
            }
        }
        WriteRunJson(runDir, run)
        let artifact = TriageArtifact{
            RunId: "run-y",
            CorpusAppId: "src/Dependent",
            Stage: "compile",
            Category: "compile-error",
            Diagnostic: TriageDiagnostic{
                Id: "GS0157",
                Message: "Cannot find type CliPaths. Are you missing an import?",
                Severity: "error"
            },
            SourceLocation: TriageSourceLocation{GsLine: 39, GsColumn: 42},
            OffendingCSharpConstruct: TriageOffendingConstruct{
                Kind: "GSharpConstruct",
                Snippet: "<emitted G# line unavailable>"
            },
            SuggestedIssue: TriageSuggestedIssue{Title: "[cs2gs] GS0157", Body: "body", Labels: List[string]{"Oats"}},
            Fingerprint: "sha256:nofile"
        }
        WriteArtifact(runDir, "src_Dependent/compile-nofile.json", artifact)
        let model = ReportModel.FromRunDirectory(runDir)
        let html = HtmlReportWriter.Render(model)
        Assert.Contains("Cannot find type CliPaths", html, StringComparison.Ordinal)
        Assert.Contains("<li><span class=\"app\">src/Dependent</span></li>", html, StringComparison.Ordinal)
        Assert.DoesNotContain(":39:42", html, StringComparison.Ordinal)
    }

    /// The HTML render is deterministic: the same model yields byte-identical
    /// output (ADR-0115 §F diffability requirement).
    @Fact
    func HtmlReport_IsDeterministic() {
        let runDir = WriteSyntheticRun()
        let first = HtmlReportWriter.Render(ReportModel.FromRunDirectory(runDir))
        let second = HtmlReportWriter.Render(ReportModel.FromRunDirectory(runDir))
        Assert.Equal(first, second)
    }

    /// Both writers persist `report.html` and `summary.json` into the
    /// run directory (ADR-0115 §F).
    @Fact
    func Writers_PersistBothArtifacts() {
        let runDir = WriteSyntheticRun()
        let model = ReportModel.FromRunDirectory(runDir)
        let htmlPath = HtmlReportWriter.Write(model, runDir)
        let jsonPath = JsonSummaryWriter.Write(model, runDir)
        Assert.True(File.Exists(htmlPath))
        Assert.True(File.Exists(jsonPath))
        Assert.Equal("report.html", Path.GetFileName(htmlPath))
        Assert.Equal("summary.json", Path.GetFileName(jsonPath))
    }

    /// A FAILED run whose triage artifacts are missing on disk (deleted,
    /// partially copied, etc.) must not be rendered as green: the "no gaps"
    /// message is conditional on (cref:ReportModel.IsGreen) — positive
    /// evidence of success — not on (cref:ReportModel.Gaps) merely being
    /// empty, since a missing artifact silently drops its gap from the list
    /// (issue #1753).
    @Fact
    func ReportModel_FailedRun_MissingTriageArtifact_IsNotRenderedAsGreen() {
        let runDir = NewRunDir("missing-artifact")
        let run = RunResult{
            RunId: "2026-03-01T00-00-00Z_missing",
            Timestamp: "2026-03-01T00:00:00Z",
            GscVersion: "0.2.0+test",
            GscPath: "/path/to/gsc.dll",
            Succeeded: false,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/L1-Console",
                    Succeeded: false,
                    FailureCategory: "translation-unsupported",
                    Stages: List[StageResult]{
                        StageResult{Stage: "translate", Status: "failed", ArtifactCount: 1},
                        StageResult{Stage: "compile", Status: "skipped"},
                        StageResult{Stage: "ilverify", Status: "skipped"},
                        StageResult{Stage: "test-parity", Status: "skipped"}
                    },
                    Artifacts: List[string]{"corpus_L1-Console/translate-missing.json"}
                }
            }
        }
        WriteRunJson(runDir, run)
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.False(model.Succeeded)
        Assert.Empty(model.Gaps)
        Assert.Equal(1, model.MissingArtifactCount)
        Assert.False(model.IsGreen)
        let html = HtmlReportWriter.Render(model)
        Assert.DoesNotContain("every app is green", html, StringComparison.Ordinal)
        Assert.Contains("NOT a green run", html, StringComparison.Ordinal)
        Assert.Contains("Gap data unavailable", html, StringComparison.Ordinal)
        let json = JsonSummaryWriter.Serialize(model)
        Assert.Contains("\"missingArtifactCount\": 1", json, StringComparison.Ordinal)
        Assert.Contains("\"isGreen\": false", json, StringComparison.Ordinal)
    }

    /// A malformed (invalid-JSON) triage artifact must be counted exactly
    /// like a missing or null-deserialize artifact — increment
    /// (cref:ReportModel.MissingArtifactCount) and continue — instead
    /// of letting the (cref:System.Text.Json.JsonException) escape and
    /// abort the whole report. One bad artifact must not nuke the rest of the
    /// run's report (issue #1846).
    @Fact
    func ReportModel_MalformedTriageArtifact_IsCountedAndReportStillRenders() {
        let runDir = NewRunDir("malformed-artifact")
        let run = RunResult{
            RunId: "2026-03-01T00-00-03Z_malformed",
            Timestamp: "2026-03-01T00:00:03Z",
            GscVersion: "0.2.0+test",
            GscPath: "/path/to/gsc.dll",
            Succeeded: false,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/L1-Console",
                    Succeeded: false,
                    FailureCategory: "translation-unsupported",
                    Stages: List[StageResult]{
                        StageResult{Stage: "translate", Status: "failed", ArtifactCount: 1},
                        StageResult{Stage: "compile", Status: "skipped"},
                        StageResult{Stage: "ilverify", Status: "skipped"},
                        StageResult{Stage: "test-parity", Status: "skipped"}
                    },
                    Artifacts: List[string]{"corpus_L1-Console/translate-malformed.json"}
                },
                AppResult{AppId: "corpus/L2-Library", Succeeded: true, Stages: AllStages("passed")}
            }
        }
        WriteRunJson(runDir, run)
        // Write invalid JSON to the referenced artifact path: not missing,
        // not null-deserializing to a valid object — a genuine parse failure.
        let artifactPath = Path.Combine(runDir, "corpus_L1-Console", "translate-malformed.json")
        Directory.CreateDirectory(Path.GetDirectoryName(artifactPath)!!)
        File.WriteAllText(artifactPath, "{ this is not valid json ")
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.False(model.Succeeded)
        Assert.Empty(model.Gaps)
        Assert.Equal(1, model.MissingArtifactCount)
        Assert.False(model.IsGreen)
        // Both apps still rendered: the malformed artifact did not abort the
        // rest of the report.
        Assert.Equal(2, model.Apps.Count)
        Assert.Contains(model.Apps, (a AppReport) -> a.AppId == "corpus/L1-Console")
        Assert.Contains(model.Apps, (a AppReport) -> a.AppId == "corpus/L2-Library")
        let html = HtmlReportWriter.Render(model)
        Assert.Contains("NOT a green run", html, StringComparison.Ordinal)
        Assert.Contains("Gap data unavailable", html, StringComparison.Ordinal)
        let json = JsonSummaryWriter.Serialize(model)
        Assert.Contains("\"missingArtifactCount\": 1", json, StringComparison.Ordinal)
        Assert.Contains("\"isGreen\": false", json, StringComparison.Ordinal)
        // Report was generated (no abort): exit code is the non-green 1, not
        // the internal-error 2 reserved for genuinely unexpected failures.
        Assert.Equal(1, Program.DetermineMigrateExitCode(model.Succeeded, reportGenerated: true))
    }

    /// A FAILED run with no triage artifacts referenced at all (e.g. every
    /// stage errored before it could emit one) must also not be rendered as
    /// green — the empty-gaps message must reflect the failed run, not claim
    /// success by omission (issue #1753).
    @Fact
    func ReportModel_FailedRun_NoArtifactsReferenced_IsNotRenderedAsGreen() {
        let runDir = NewRunDir("no-artifacts-failed")
        let run = RunResult{
            RunId: "2026-03-01T00-00-01Z_noartifacts",
            Timestamp: "2026-03-01T00:00:01Z",
            GscVersion: "0.2.0+test",
            GscPath: "/path/to/gsc.dll",
            Succeeded: false,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/L1-Console",
                    Succeeded: false,
                    FailureCategory: "pipeline-crash",
                    Stages: AllStages("skipped")
                }
            }
        }
        WriteRunJson(runDir, run)
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.False(model.Succeeded)
        Assert.Empty(model.Gaps)
        Assert.Equal(0, model.MissingArtifactCount)
        Assert.False(model.IsGreen)
        let html = HtmlReportWriter.Render(model)
        Assert.DoesNotContain("every app is green", html, StringComparison.Ordinal)
        Assert.Contains("Run FAILED with no recorded gaps", html, StringComparison.Ordinal)
    }

    /// A genuinely green run — every app succeeded, every referenced artifact
    /// was readable, and zero gaps were found — must still render as green
    /// (positive evidence, not merely an empty gap list) and, at the CLI layer,
    /// still exit 0 (issue #1753).
    @Fact
    func ReportModel_GenuinelyGreenRun_IsRenderedAsGreen() {
        let runDir = NewRunDir("genuinely-green")
        let run = RunResult{
            RunId: "2026-03-01T00-00-02Z_green",
            Timestamp: "2026-03-01T00:00:02Z",
            GscVersion: "0.2.0+test",
            GscPath: "/path/to/gsc.dll",
            Succeeded: true,
            Apps: List[AppResult]{AppResult{AppId: "corpus/L1-Console", Succeeded: true, Stages: AllStages("passed")}}
        }
        WriteRunJson(runDir, run)
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.True(model.Succeeded)
        Assert.Empty(model.Gaps)
        Assert.Equal(0, model.MissingArtifactCount)
        Assert.True(model.IsGreen)
        // Nothing skipped: not unverified, and the app is counted green.
        Assert.False(model.Unverified)
        Assert.Equal(0, model.UnverifiedApps)
        Assert.Equal(1, model.GreenApps)
        let html = HtmlReportWriter.Render(model)
        Assert.Contains("every app is green", html, StringComparison.Ordinal)
        Assert.Equal(0, Program.DetermineMigrateExitCode(model.Succeeded, reportGenerated: true))
    }

    /// A run with an unverified stage (e.g. no locally-built SDK for
    /// `compile`) but no failed stage must not roll up to a green app or
    /// a plain "PASSED" verdict — the aggregate rollup must carry the same
    /// "not verified" honesty as the per-stage `skipped` cell (issue
    /// #1749), one level up (issue #1831). Exit code must still be 0: a
    /// genuinely-unavailable SDK must never turn CI red.
    @Fact
    func ReportModel_SkippedStageNoFailure_IsUnverifiedNotGreen_AndExitsZero() {
        let runDir = NewRunDir("unverified")
        let run = RunResult{
            RunId: "2026-03-01T00-00-03Z_unverified",
            Timestamp: "2026-03-01T00:00:03Z",
            GscVersion: "0.2.0+test",
            GscPath: "/path/to/gsc.dll",
            Succeeded: true,
            Unverified: true,
            Apps: List[AppResult]{
                AppResult{
                    AppId: "corpus/L1-Console",
                    Succeeded: true,
                    Unverified: true,
                    Stages: List[StageResult]{
                        StageResult{Stage: "translate", Status: "passed"},
                        StageResult{Stage: "compile", Status: "skipped"},
                        StageResult{Stage: "ilverify", Status: "skipped"},
                        StageResult{Stage: "test-parity", Status: "skipped"}
                    }
                }
            }
        }
        WriteRunJson(runDir, run)
        let model = ReportModel.FromRunDirectory(runDir)
        Assert.True(model.Succeeded)
        Assert.True(model.Unverified)
        Assert.Equal(1, model.TotalApps)
        Assert.Equal(0, model.GreenApps)
        Assert.Equal(1, model.UnverifiedApps)
        Assert.False(model.IsGreen)
        let html = HtmlReportWriter.Render(model)
        Assert.DoesNotContain("every app is green", html, StringComparison.Ordinal)
        Assert.Contains("PASSED (unverified)", html, StringComparison.Ordinal)
        Assert.Contains("1 unverified", html, StringComparison.Ordinal)
        Assert.Contains("class=\"state skip\">unverified</span>", html, StringComparison.Ordinal)
        // Skipped-only must not turn the run red or non-zero (SDK-absent CI is legitimate).
        Assert.Equal(0, Program.DetermineMigrateExitCode(model.Succeeded, reportGenerated: true))
    }

    /// `migrate` must not swallow a report-generation failure: when
    /// `GenerateReport` cannot build/write the report (e.g. a corrupt
    /// `run.json`), it surfaces the error on stderr and reports failure
    /// back to the caller instead of silently returning success, and the
    /// combined migrate exit code is non-zero even though the migration run
    /// itself passed (issue #1753).
    @Fact
    func GenerateReport_WhenRunJsonIsMissing_ReturnsFalseAndSurfacesError() {
        let runDir = NewRunDir("broken-run-json")
        // No run.json written: ReportModel.FromRunDirectory throws
        // FileNotFoundException, which GenerateReport must catch, log, and
        // report back as a failure rather than swallow.
        let originalError = Console.Error
        let captured = StringWriter()
        Console.SetError(captured)
        var generated bool
        try {
            generated = Program.GenerateReport(runDir)
        } finally {
            Console.SetError(originalError)
        }
        Assert.False(generated)
        Assert.Contains("failed to generate report", captured.ToString(), StringComparison.Ordinal)
        // Even though the run itself would have passed, the report failure
        // must dominate the exit code (non-zero), so a broken report is never
        // invisible behind a clean exit 0.
        Assert.Equal(2, Program.DetermineMigrateExitCode(runSucceeded: true, reportGenerated: generated))
        Assert.Equal(2, Program.DetermineMigrateExitCode(runSucceeded: false, reportGenerated: generated))
    }

    /// The migrate exit-code seam in isolation: a successful report always
    /// yields the run's own pass/fail exit code (0/1); a failed report always
    /// yields 2, regardless of the run's outcome (issue #1753).
    @Theory
    @InlineData(true, true, int32(0))
    @InlineData(false, true, int32(1))
    @InlineData(true, false, int32(2))
    @InlineData(false, false, int32(2))
    func DetermineMigrateExitCode_ReportFailureDominates(runSucceeded bool, reportGenerated bool, expected int32) {
        Assert.Equal(expected, Program.DetermineMigrateExitCode(runSucceeded, reportGenerated))
    }

    /// The CLI `report --run <dir>` verb regenerates both
    /// `report.html` and `summary.json` from an existing run directory
    /// without re-running the pipeline (ADR-0115 §F).
    @Fact
    func Cli_ReportVerb_RegeneratesBothArtifacts() {
        let cliDll string? = FindCliDll()
        Assert.True(cliDll != nil, "cs2gs.dll not found; build the solution first.")
        let runDir = WriteSyntheticRun()
        File.Delete(Path.Combine(runDir, "summary.json"))
        Assert.False(File.Exists(Path.Combine(runDir, "report.html")))
        let psi = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        psi.ArgumentList.Add(cliDll!!)
        psi.ArgumentList.Add("report")
        psi.ArgumentList.Add("--run")
        psi.ArgumentList.Add(runDir)
        using let process Process? = Process.Start(psi)
        let stdout = process!!.StandardOutput.ReadToEnd()
        process!!.WaitForExit()
        Assert.Equal(0, process!!.ExitCode)
        Assert.True(File.Exists(Path.Combine(runDir, "report.html")), stdout)
        Assert.True(File.Exists(Path.Combine(runDir, "summary.json")), stdout)
        AssertArtifactLinksResolve(Path.Combine(runDir, "report.html"), runDir)
    }

    /// `report --out` to a directory other than the run dir (sibling or
    /// parent) must still emit triage-artifact links that resolve to the real
    /// artifact files from the report's actual location (issue #1754, bug 1).
    @Theory
    @InlineData("sibling")
    @InlineData("nested/deeper")
    @InlineData("..")
    func Cli_ReportVerb_OutToOtherDir_LinksResolveToRealArtifacts(relativeOut string) {
        let cliDll string? = FindCliDll()
        Assert.True(cliDll != nil, "cs2gs.dll not found; build the solution first.")
        let runDir = WriteSyntheticRun()
        let outDir = Path.GetFullPath(Path.Combine(runDir, relativeOut, "report-out-" + Guid.NewGuid().ToString("N")))
        let stdout = RunCli(cliDll, "report", "--run", runDir, "--out", outDir)
        let htmlPath = Path.Combine(outDir, "report.html")
        Assert.True(File.Exists(htmlPath), stdout)
        Assert.True(File.Exists(Path.Combine(outDir, "summary.json")), stdout)
        AssertArtifactLinksResolve(htmlPath, outDir)
    }

    /// `report --out <dir>/<file>.html` honors the supplied file
    /// name for `report.html` instead of silently discarding it, while
    /// `summary.json` keeps its default name alongside it (issue #1754,
    /// bug 2).
    @Fact
    func Cli_ReportVerb_OutWithExplicitHtmlFileName_UsesGivenFileName() {
        let cliDll string? = FindCliDll()
        Assert.True(cliDll != nil, "cs2gs.dll not found; build the solution first.")
        let runDir = WriteSyntheticRun()
        let outDir = Path.Combine(runDir, "custom-" + Guid.NewGuid().ToString("N"))
        let outFile = Path.Combine(outDir, "mysummary.html")
        let stdout = RunCli(cliDll, "report", "--run", runDir, "--out", outFile)
        Assert.True(File.Exists(outFile), stdout)
        Assert.False(File.Exists(Path.Combine(outDir, "report.html")), stdout)
        Assert.True(File.Exists(Path.Combine(outDir, "summary.json")), stdout)
        AssertArtifactLinksResolve(outFile, outDir)
    }

    /// `report --out <dir>/<file>.json` honors the supplied file
    /// name for `summary.json`, while `report.html` keeps its default
    /// name (issue #1754, bug 2).
    @Fact
    func Cli_ReportVerb_OutWithExplicitJsonFileName_UsesGivenFileName() {
        let cliDll string? = FindCliDll()
        Assert.True(cliDll != nil, "cs2gs.dll not found; build the solution first.")
        let runDir = WriteSyntheticRun()
        let outDir = Path.Combine(runDir, "custom-" + Guid.NewGuid().ToString("N"))
        let outFile = Path.Combine(outDir, "run-summary.json")
        let stdout = RunCli(cliDll, "report", "--run", runDir, "--out", outFile)
        Assert.True(File.Exists(outFile), stdout)
        Assert.False(File.Exists(Path.Combine(outDir, "summary.json")), stdout)
        Assert.True(File.Exists(Path.Combine(outDir, "report.html")), stdout)
    }

    /// A `--out` path with a dotted-but-unrecognized "extension" (e.g. a
    /// dated directory name) is still treated as a directory, not
    /// misinterpreted as a file (issue #1754, bug 2 edge case).
    @Fact
    func Cli_ReportVerb_OutWithDottedDirectoryName_TreatedAsDirectory() {
        let cliDll string? = FindCliDll()
        Assert.True(cliDll != nil, "cs2gs.dll not found; build the solution first.")
        let runDir = WriteSyntheticRun()
        let outDir = Path.Combine(runDir, "out", "run.2026-07-01")
        let stdout = RunCli(cliDll, "report", "--run", runDir, "--out", outDir)
        Assert.True(File.Exists(Path.Combine(outDir, "report.html")), stdout)
        Assert.True(File.Exists(Path.Combine(outDir, "summary.json")), stdout)
    }

    shared {
        /// Parses every triage-artifact `href` out of a rendered
        /// `report.html` and asserts each one resolves, relative to
        /// [`reportDir`](paramref), to a triage artifact file that actually
        /// exists.
        private func AssertArtifactLinksResolve(reportHtmlPath string, reportDir string) {
            let html = File.ReadAllText(reportHtmlPath)
            let matches = Regex.Matches(html, "<li><a href=\"([^\"]+)\">")
            Assert.NotEmpty(matches)
            for match Match in matches {
                let href = Uri.UnescapeDataString(match.Groups[1].Value)
                let resolved = Path.GetFullPath(Path.Combine(reportDir, href.Replace('/', Path.DirectorySeparatorChar)))
                Assert.True(
                    File.Exists(resolved),
                    "artifact link '$href' does not resolve to an existing file at '$resolved'."
                )
            }
        }

        private func RunCli(cliDll string?, args ...string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            psi.ArgumentList.Add(cliDll!!)
            for arg in args {
                psi.ArgumentList.Add(arg)
            }
            using let process Process? = Process.Start(psi)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.Equal(0, process!!.ExitCode)
            return stdout + stderr
        }

        private func FindCliDll() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Cs2Gs.Cli", "cs2gs.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        private func WriteSyntheticRun() string {
            let runDir = NewRunDir("model")
            let run = RunResult{
                RunId: "2026-02-02T00-00-00Z_abc123",
                Timestamp: "2026-02-02T00:00:00Z",
                GscVersion: "0.2.0+test",
                GscPath: "/path/to/gsc.dll",
                Succeeded: false,
                Apps: List[AppResult]{
                    AppResult{AppId: "corpus/L1-Console", Succeeded: true, Stages: AllStages("passed")},
                    AppResult{
                        AppId: "corpus/L3-Library",
                        Succeeded: false,
                        FailureCategory: "translation-unsupported",
                        Stages: List[StageResult]{
                            StageResult{Stage: "translate", Status: "failed", ArtifactCount: 2},
                            StageResult{Stage: "compile", Status: "skipped"},
                            StageResult{Stage: "ilverify", Status: "skipped"},
                            StageResult{Stage: "test-parity", Status: "skipped"}
                        },
                        Artifacts: List[string]{
                            "corpus_L3-Library/translate-unique3.json",
                            "corpus_L3-Library/translate-shared.json"
                        },
                        Fingerprints: List[string]{"sha256:unique30bbbb", "sha256:shared00aaaa"}
                    },
                    AppResult{
                        AppId: "corpus/L2-Library",
                        Succeeded: false,
                        FailureCategory: "translation-unsupported",
                        Stages: List[StageResult]{
                            StageResult{Stage: "translate", Status: "failed", ArtifactCount: 1},
                            StageResult{Stage: "compile", Status: "skipped"},
                            StageResult{Stage: "ilverify", Status: "skipped"},
                            StageResult{Stage: "test-parity", Status: "skipped"}
                        },
                        Artifacts: List[string]{"corpus_L2-Library/translate-shared.json"},
                        Fingerprints: List[string]{"sha256:shared00aaaa"}
                    }
                }
            }
            WriteRunJson(runDir, run)
            WriteArtifact(
                runDir,
                "corpus_L3-Library/translate-unique3.json",
                MakeArtifact("corpus/L3-Library", "sha256:unique30bbbb", "UniqueKind", retry: nil)
            )
            WriteArtifact(
                runDir,
                "corpus_L3-Library/translate-shared.json",
                MakeArtifact(
                    "corpus/L3-Library",
                    "sha256:shared00aaaa",
                    "SharedKind",
                    retry: TriageRetryEntry{RunId: "run-b", GscVersion: "0.1.0", Result: "fail"}
                )
            )
            WriteArtifact(
                runDir,
                "corpus_L2-Library/translate-shared.json",
                MakeArtifact(
                    "corpus/L2-Library",
                    "sha256:shared00aaaa",
                    "SharedKind",
                    retry: TriageRetryEntry{RunId: "run-a", GscVersion: "0.0.9", Result: "fail"}
                )
            )
            return runDir
        }

        private func MakeArtifact(
            appId string,
            fingerprint string,
            kind string,
            retry TriageRetryEntry?
        ) TriageArtifact {
            let artifact = TriageArtifact{
                RunId: "2026-02-02T00-00-00Z_abc123",
                Timestamp: "2026-02-02T00:00:00Z",
                GscVersion: "0.2.0+test",
                CorpusAppId: appId,
                Stage: "translate",
                Category: "translation-unsupported",
                Diagnostic: TriageDiagnostic{Id: "CS2GS-UNSUPPORTED", Message: "Unsupported $kind", Severity: "error"},
                SourceLocation: TriageSourceLocation{CsFile: "$appId/Src.cs"},
                OffendingCSharpConstruct: TriageOffendingConstruct{Kind: kind, Snippet: "snippet"},
                SuggestedIssue: TriageSuggestedIssue{
                    Title: "[cs2gs] $kind",
                    Body: "body",
                    Labels: List[string]{"Oats"}
                },
                Fingerprint: fingerprint
            }
            if retry != nil {
                artifact.RetryHistory.Add(retry)
            }
            return artifact
        }

        private func AllStages(status string) List[StageResult] {
            return List[StageResult]{
                StageResult{Stage: "translate", Status: status},
                StageResult{Stage: "compile", Status: status},
                StageResult{Stage: "ilverify", Status: status},
                StageResult{Stage: "test-parity", Status: status}
            }
        }

        private func WriteRunJson(runDir string, run RunResult) {
            File.WriteAllText(
                Path.Combine(runDir, "run.json"),
                JsonSerializer.Serialize(run, TriageSerialization.Options)
            )
        }

        private func WriteArtifact(runDir string, relative string, artifact TriageArtifact) {
            let path = Path.Combine(runDir, relative.Replace('/', Path.DirectorySeparatorChar))
            Directory.CreateDirectory(Path.GetDirectoryName(path)!!)
            File.WriteAllText(path, JsonSerializer.Serialize(artifact, TriageSerialization.Options))
        }

        private func NewRunDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "report-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }
    }
}
