// <copyright file="HtmlReportWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Report

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Net
import System.Text

/// Renders a (cref:ReportModel) to a single, self-contained
/// `report.html` (ADR-0115 §F): all CSS and JS are inlined and there are
/// NO external assets (no CDNs, fonts, or network references). It renders a
/// header (runId/timestamp/gscVersion/overall status + green-app count), the
/// per-app × per-stage status matrix (color-coded but never color-only — each
/// cell carries text and an `aria-label`), the discovered-gap list grouped
/// by fingerprint (each with category/stage/diagnostic, affected apps, the
/// suggested-issue title/labels, a collapsible body, and retry history), and a
/// per-app detail drill-down. Every interpolated value is HTML-encoded through
/// (cref:Encode), and the output is deterministic (same model ⇒
/// byte-identical HTML) so reports diff cleanly.
shared class HtmlReportWriter {
    /// The report file name written under the run directory.
    const FileName string = "report.html"

    private const Newline string = "\n"
    private let Css string = string.Join(
        Newline,
        ":root{--ok:#1a7f37;--bad:#cf222e;--skip:#6e7781;--bg:#ffffff;--fg:#1f2328;--line:#d0d7de;--panel:#f6f8fa;}",
        "*{box-sizing:border-box;}",
        "body{margin:0;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);line-height:1.45;}",
        "h1{font-size:1.5rem;margin:0 0 .25rem;}",
        "h2{font-size:1.2rem;margin:2rem 0 .75rem;border-bottom:1px solid var(--line);padding-bottom:.25rem;}",
        "h3{font-size:1rem;margin:0 0 .5rem;}",
        "a{color:#0969da;}",
        ".run-header .verdict{display:inline-block;font-weight:700;padding:.15rem .6rem;border-radius:999px;color:#fff;}",
        ".verdict.ok{background:var(--ok);} .verdict.bad{background:var(--bad);} .verdict.skip{background:var(--skip);}",
        ".provenance{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;margin:.75rem 0 0;}",
        ".provenance dt{font-weight:600;color:var(--skip);} .provenance dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
        "table{border-collapse:collapse;width:100%;}",
        ".matrix th,.matrix td{border:1px solid var(--line);padding:.4rem .6rem;text-align:left;}",
        ".matrix thead th{background:var(--panel);}",
        ".cell{font-weight:600;white-space:nowrap;}",
        ".cell .dot{display:inline-block;width:.65rem;height:.65rem;border-radius:50%;margin-right:.4rem;vertical-align:middle;}",
        ".cell.pass{color:var(--ok);} .cell.pass .dot{background:var(--ok);}",
        ".cell.fail{color:var(--bad);} .cell.fail .dot{background:var(--bad);}",
        ".cell.skip{color:var(--skip);} .cell.skip .dot{background:var(--skip);}",
        ".gap{border:1px solid var(--line);border-radius:6px;padding:1rem;margin:0 0 1rem;background:var(--panel);}",
        ".gap-meta{list-style:none;margin:0 0 .5rem;padding:0;display:flex;flex-wrap:wrap;gap:.35rem 1rem;}",
        ".gap-meta .k{font-weight:600;color:var(--skip);} .gap-meta .v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
        ".snippet,.issue-body{background:#0d1117;color:#e6edf3;padding:.6rem .8rem;border-radius:6px;overflow:auto;}",
        ".snippet code,.issue-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;}",
        ".labels{margin:.5rem 0;} .label{display:inline-block;background:#ddf4ff;color:#0969da;border:1px solid #54aeff66;border-radius:999px;padding:.05rem .55rem;font-size:.8rem;}",
        ".occurrences ul{margin:.25rem 0;padding-left:1.2rem;} .occurrences .app{font-weight:600;} .occurrences .loc{color:var(--skip);font-family:ui-monospace,monospace;}",
        ".retry th,.retry td{border:1px solid var(--line);padding:.25rem .5rem;text-align:left;font-size:.85rem;}",
        ".toggle{margin:.5rem 0;cursor:pointer;background:#fff;border:1px solid var(--line);border-radius:6px;padding:.3rem .7rem;font:inherit;}",
        ".app-detail{border:1px solid var(--line);border-radius:6px;padding:1rem;margin:0 0 1rem;}",
        ".state{font-size:.75rem;padding:.1rem .5rem;border-radius:999px;color:#fff;vertical-align:middle;}",
        ".state.ok{background:var(--ok);} .state.bad{background:var(--bad);} .state.skip{background:var(--skip);}",
        ".stage-list th,.stage-list td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left;}",
        ".meta-line .k,.artifact-h{font-weight:600;color:var(--skip);}",
        ".empty{color:var(--skip);}"
    ) +
        Newline
    private let Js string = string.Join(
        Newline,
        "(function(){",
        "  var buttons = document.querySelectorAll('.toggle');",
        "  for (var i = 0; i < buttons.length; i++) {",
        "    buttons[i].addEventListener('click', function(){",
        "      var id = this.getAttribute('data-target');",
        "      var target = document.getElementById(id);",
        "      if (!target) { return; }",
        "      var hidden = target.hasAttribute('hidden');",
        "      if (hidden) { target.removeAttribute('hidden'); } else { target.setAttribute('hidden',''); }",
        "      this.setAttribute('aria-expanded', hidden ? 'true' : 'false');",
        "    });",
        "  }",
        "})();"
    ) +
        Newline

    /// Renders the model to a self-contained HTML document. Triage-artifact
    /// links are resolved relative to [`outputDir`](paramref) (defaulting
    /// to (cref:ReportModel.RunDir), i.e. as if the document were
    /// written into the run dir) so the same model renders correct, clickable
    /// links no matter where `report.html` ultimately lives.
    /// @param model The aggregated report model.
    /// @param outputDir The directory the rendered document will be written into. Defaults to
    /// (cref:ReportModel.RunDir) when `null`.
    /// @returns The deterministic HTML text.
    func Render(model ReportModel?, outputDir string? = nil) string {
        var outputDir = outputDir
        if model == nil {
            throw ArgumentNullException("model")
        }
        outputDir = Path.GetFullPath(outputDir ?? model.RunDir)
        let slugs = BuildSlugMap(model)
        let sb = StringBuilder()
        sb.Append("<!DOCTYPE html>").Append(Newline)
        sb.Append("<html lang=\"en\">").Append(Newline)
        AppendHead(sb, model)
        sb.Append("<body>").Append(Newline)
        AppendHeader(sb, model)
        AppendMatrix(sb, model, slugs)
        AppendGaps(sb, model)
        AppendAppDetails(sb, model, outputDir, slugs)
        AppendScript(sb)
        sb.Append("</body>").Append(Newline)
        sb.Append("</html>").Append(Newline)
        return sb.ToString()
    }

    /// Writes `report.html` into [`outputDir`](paramref) (which may
    /// differ from the run dir the model was built from) and returns its path.
    /// Triage-artifact links are rewritten relative to [`outputDir`](paramref)
    /// so they resolve from wherever the document is written.
    /// @param model The aggregated report model.
    /// @param outputDir The directory to write `report.html` into.
    /// @param fileName The file name to write, defaulting to (cref:FileName) (`report.html`)
    /// when `null` or empty. Lets `--out <file>` honor a
    /// user-supplied report file name.
    /// @returns The full path of the written file.
    func Write(model ReportModel, outputDir string, fileName string? = nil) string {
        if string.IsNullOrEmpty(outputDir) {
            throw ArgumentException("Output directory is required.", "outputDir")
        }
        Directory.CreateDirectory(outputDir)
        let path = Path.Combine(
            outputDir,
            if string.IsNullOrEmpty(fileName) {
                FileName
            } else {
                fileName
            }
        )
        File.WriteAllText(path, Render(model, outputDir))
        return path
    }

    /// HTML-encodes a value for safe interpolation into the document. This is
    /// the single encode helper used for EVERY interpolated value (diagnostic
    /// messages, C# snippets, issue titles/bodies all originate from source code
    /// and must be escaped to prevent broken or injected markup). A
    /// `null` value encodes to the empty string.
    /// @param value The raw value.
    /// @returns The HTML-encoded text.
    func Encode(value string?) string? {
        return if value == nil {
            string.Empty
        } else {
            WebUtility.HtmlEncode(value)
        }
    }

    private func AppendHead(sb StringBuilder, model ReportModel) {
        sb.Append("<head>").Append(Newline)
        sb.Append("<meta charset=\"utf-8\">").Append(Newline)
        sb.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">").Append(Newline)
        sb.Append("<title>cs2gs report — ").Append(Encode(model.RunId)).Append("</title>").Append(Newline)
        sb.Append("<style>").Append(Newline)
        sb.Append(Css)
        sb.Append("</style>").Append(Newline)
        sb.Append("</head>").Append(Newline)
    }

    private func AppendHeader(sb StringBuilder, model ReportModel) {
        // Precedence per ADR-0115 §C (issue #1831): a failed run is always
        // "FAILED"/red; otherwise, any unverified app makes the run
        // "PASSED (unverified)"/skip-colored rather than a plain green pass —
        // "not verified" must never render as verified-green, one level up
        // from the per-stage fix in issue #1749.
        let verdict = if !model.Succeeded {
            "FAILED"
        } else {
            (
                if model.Unverified {
                    "PASSED (unverified)"
                } else {
                    "PASSED"
                }
            )
        }
        let verdictClass = if !model.Succeeded {
            "bad"
        } else {
            (
                if model.Unverified {
                    "skip"
                } else {
                    "ok"
                }
            )
        }
        sb.Append("<header class=\"run-header\">").Append(Newline)
        sb.Append("<h1>cs2gs migration report</h1>").Append(Newline)
        sb
            .Append("<p class=\"verdict ")
            .Append(verdictClass)
            .Append("\">")
            .Append("Run ")
            .Append(verdict)
            .Append(" — ")
            .Append(model.GreenApps.ToString(CultureInfo.InvariantCulture))
            .Append('/')
            .Append(model.TotalApps.ToString(CultureInfo.InvariantCulture))
            .Append(" apps green")
        if model.UnverifiedApps > 0 {
            sb.Append(", ").Append(model.UnverifiedApps.ToString(CultureInfo.InvariantCulture)).Append(" unverified")
        }
        sb.Append("</p>").Append(Newline)
        sb.Append("<dl class=\"provenance\">").Append(Newline)
        AppendDefinition(sb, "Run id", model.RunId)
        AppendDefinition(sb, "Timestamp", model.Timestamp)
        AppendDefinition(sb, "gsc version", model.GscVersion)
        sb.Append("</dl>").Append(Newline)
        sb.Append("</header>").Append(Newline)
    }

    private func AppendDefinition(sb StringBuilder, term string, value string) {
        sb
            .Append("<dt>")
            .Append(Encode(term))
            .Append("</dt>")
            .Append("<dd>")
            .Append(Encode(value))
            .Append("</dd>")
            .Append(Newline)
    }

    private func AppendMatrix(sb StringBuilder, model ReportModel, slugs Dictionary[string, string]) {
        sb.Append("<section aria-labelledby=\"matrix-h\">").Append(Newline)
        sb.Append("<h2 id=\"matrix-h\">Status matrix</h2>").Append(Newline)
        sb.Append("<table class=\"matrix\">").Append(Newline)
        sb.Append("<thead><tr><th scope=\"col\">app</th>")
        for stage in model.StageOrder {
            sb.Append("<th scope=\"col\">").Append(Encode(stage)).Append("</th>")
        }
        sb.Append("</tr></thead>").Append(Newline)
        sb.Append("<tbody>").Append(Newline)
        for app in model.Apps {
            sb.Append("<tr>")
            sb
                .Append("<th scope=\"row\"><a href=\"#app-")
                .Append(slugs[app.AppId])
                .Append("\">")
                .Append(Encode(app.AppId))
                .Append("</a></th>")
            for stageName in model.StageOrder {
                let stage StageResult? = app.Stages.FirstOrDefault(
                    (s StageResult) -> string.Equals(s.Stage, stageName, StringComparison.Ordinal)
                )
                AppendMatrixCell(sb, stage)
            }
            sb.Append("</tr>").Append(Newline)
        }
        sb.Append("</tbody>").Append(Newline)
        sb.Append("</table>").Append(Newline)
        sb.Append("</section>").Append(Newline)
    }

    private func AppendMatrixCell(sb StringBuilder, stage StageResult?) {
        let status = stage?.Status ?? "skipped"
        let info(Label string, Css string, Word string) = switch status {
            case "passed": ("PASS", "pass", "passed")
            case "failed": ("FAIL", "fail", "failed")
            case "skipped": ("SKIP", "skip", "skipped")
            default: (status.ToUpperInvariant(), "skip", status)
        }
        var label = info.Label
        if string.Equals(status, "failed", StringComparison.Ordinal) && stage != nil && stage.ArtifactCount > 0 {
            label = info.Label + " (" + stage.ArtifactCount.ToString(CultureInfo.InvariantCulture) + ")"
        }
        sb
            .Append("<td class=\"cell ")
            .Append(info.Css)
            .Append("\" aria-label=\"")
            .Append(Encode(info.Word))
            .Append("\">")
            .Append("<span class=\"dot\" aria-hidden=\"true\"></span>")
            .Append(Encode(label))
            .Append("</td>")
    }

    private func AppendGaps(sb StringBuilder, model ReportModel) {
        sb.Append("<section aria-labelledby=\"gaps-h\">").Append(Newline)
        sb
            .Append("<h2 id=\"gaps-h\">Discovered gaps (")
            .Append(model.Gaps.Count.ToString(CultureInfo.InvariantCulture))
            .Append(")</h2>")
            .Append(Newline)
        if model.Gaps.Count == 0 {
            if model.IsGreen {
                sb.Append("<p class=\"empty\">No gaps — every app is green.</p>").Append(Newline)
            } else if model.MissingArtifactCount > 0 {
                sb
                    .Append("<p class=\"empty bad\">Gap data unavailable — ")
                    .Append(model.MissingArtifactCount.ToString(CultureInfo.InvariantCulture))
                    .Append(" triage artifact(s) referenced by this run could not be read. ")
                    .Append("This is NOT a green run; re-run triage or inspect the run directory.</p>")
                    .Append(Newline)
            } else {
                sb
                    .Append("<p class=\"empty bad\">Run FAILED with no recorded gaps — check pipeline logs; ")
                    .Append("this is NOT a green run.</p>")
                    .Append(Newline)
            }
            sb.Append("</section>").Append(Newline)
            return
        }
        var index = 0
        for gap in model.Gaps {
            AppendGap(sb, gap, index)
            index++
        }
        sb.Append("</section>").Append(Newline)
    }

    private func AppendGap(sb StringBuilder, gap GapReport, index int32) {
        let bodyId = "gap-body-" + index.ToString(CultureInfo.InvariantCulture)
        let title string? = gap.SuggestedIssue?.Title
        let headline string? = if string.IsNullOrEmpty(title) {
            (gap.Diagnostic?.Id ?? gap.Fingerprint)
        } else {
            title
        }
        sb.Append("<article class=\"gap\">").Append(Newline)
        sb.Append("<h3>").Append(Encode(headline)).Append("</h3>").Append(Newline)
        sb.Append("<ul class=\"gap-meta\">").Append(Newline)
        AppendMetaItem(sb, "fingerprint", gap.Fingerprint)
        AppendMetaItem(sb, "category", gap.Category)
        AppendMetaItem(sb, "stage", gap.Stage)
        AppendMetaItem(sb, "diagnostic", FormatDiagnostic(gap.Diagnostic))
        AppendMetaItem(sb, "construct", gap.OffendingCSharpConstruct?.Kind)
        sb.Append("</ul>").Append(Newline)
        if !string.IsNullOrEmpty(gap.OffendingCSharpConstruct?.Snippet) {
            sb
                .Append("<pre class=\"snippet\"><code>")
                .Append(Encode(gap.OffendingCSharpConstruct.Snippet))
                .Append("</code></pre>")
                .Append(Newline)
        }
        AppendLabels(sb, gap.SuggestedIssue?.Labels)
        AppendOccurrences(sb, gap.Occurrences)
        AppendRetryHistory(sb, gap.RetryHistory)
        if !string.IsNullOrEmpty(gap.SuggestedIssue?.Body) {
            sb
                .Append("<button type=\"button\" class=\"toggle\" aria-expanded=\"false\" aria-controls=\"")
                .Append(bodyId)
                .Append("\" data-target=\"")
                .Append(bodyId)
                .Append("\">Suggested issue body</button>")
                .Append(Newline)
            sb
                .Append("<pre id=\"")
                .Append(bodyId)
                .Append("\" class=\"issue-body\" hidden><code>")
                .Append(Encode(gap.SuggestedIssue.Body))
                .Append("</code></pre>")
                .Append(Newline)
        }
        sb.Append("</article>").Append(Newline)
    }

    private func AppendMetaItem(sb StringBuilder, label string, value string?) {
        if string.IsNullOrEmpty(value) {
            return
        }
        sb
            .Append("<li><span class=\"k\">")
            .Append(Encode(label))
            .Append("</span> ")
            .Append("<span class=\"v\">")
            .Append(Encode(value))
            .Append("</span></li>")
            .Append(Newline)
    }

    private func AppendLabels(sb StringBuilder, labels IReadOnlyList[string]?) {
        if labels == nil || labels.Count == 0 {
            return
        }
        sb.Append("<p class=\"labels\">labels: ")
        var first = true
        for label in labels {
            if !first {
                sb.Append(' ')
            }
            sb.Append("<span class=\"label\">").Append(Encode(label)).Append("</span>")
            first = false
        }
        sb.Append("</p>").Append(Newline)
    }

    private func AppendOccurrences(sb StringBuilder, occurrences IReadOnlyList[GapOccurrence]?) {
        if occurrences == nil || occurrences.Count == 0 {
            return
        }
        sb
            .Append("<details class=\"occurrences\" open><summary>")
            .Append(occurrences.Count.ToString(CultureInfo.InvariantCulture))
            .Append(" occurrence(s)</summary>")
            .Append(Newline)
        sb.Append("<ul>").Append(Newline)
        for occurrence in occurrences {
            let location string? = FormatLocation(occurrence.SourceLocation)
            sb.Append("<li><span class=\"app\">").Append(Encode(occurrence.AppId)).Append("</span>")
            if !string.IsNullOrEmpty(location) {
                sb.Append(" <span class=\"loc\">").Append(Encode(location)).Append("</span>")
            }
            sb.Append("</li>").Append(Newline)
        }
        sb.Append("</ul>").Append(Newline)
        sb.Append("</details>").Append(Newline)
    }

    private func AppendRetryHistory(sb StringBuilder, retryHistory IReadOnlyList[TriageRetryEntry]?) {
        if retryHistory == nil || retryHistory.Count == 0 {
            return
        }
        sb
            .Append("<details class=\"retries\"><summary>retry history (")
            .Append(retryHistory.Count.ToString(CultureInfo.InvariantCulture))
            .Append(")</summary>")
            .Append(Newline)
        sb
            .Append("<table class=\"retry\"><thead><tr>")
            .Append("<th scope=\"col\">runId</th><th scope=\"col\">gscVersion</th><th scope=\"col\">result</th>")
            .Append("</tr></thead><tbody>")
            .Append(Newline)
        for entry in retryHistory {
            sb
                .Append("<tr><td>")
                .Append(Encode(entry.RunId))
                .Append("</td>")
                .Append("<td>")
                .Append(Encode(entry.GscVersion))
                .Append("</td>")
                .Append("<td>")
                .Append(Encode(entry.Result))
                .Append("</td></tr>")
                .Append(Newline)
        }
        sb.Append("</tbody></table>").Append(Newline)
        sb.Append("</details>").Append(Newline)
    }

    private func AppendAppDetails(
        sb StringBuilder,
        model ReportModel,
        outputDir string?,
        slugs Dictionary[string, string]
    ) {
        sb.Append("<section aria-labelledby=\"apps-h\">").Append(Newline)
        sb.Append("<h2 id=\"apps-h\">App details</h2>").Append(Newline)
        for app in model.Apps {
            // Same precedence as the run header (issue #1831): failed apps
            // are "bad"/red; an unverified-but-not-failed app is "skip"/gray
            // (reusing the per-stage skip color from issue #1749), never
            // green.
            let stateClass = if !app.Succeeded {
                "bad"
            } else {
                (
                    if app.Unverified {
                        "skip"
                    } else {
                        "ok"
                    }
                )
            }
            let stateLabel = if !app.Succeeded {
                "failing"
            } else {
                (
                    if app.Unverified {
                        "unverified"
                    } else {
                        "green"
                    }
                )
            }
            sb.Append("<article id=\"app-").Append(slugs[app.AppId]).Append("\" class=\"app-detail\">").Append(Newline)
            sb
                .Append("<h3>")
                .Append(Encode(app.AppId))
                .Append(" <span class=\"state ")
                .Append(stateClass)
                .Append("\">")
                .Append(stateLabel)
                .Append("</span></h3>")
                .Append(Newline)
            if !string.IsNullOrEmpty(app.FailureCategory) {
                AppendMetaLine(sb, "failure category", app.FailureCategory)
            }
            sb
                .Append("<table class=\"stage-list\"><thead><tr>")
                .Append("<th scope=\"col\">stage</th><th scope=\"col\">status</th><th scope=\"col\">artifacts</th>")
                .Append("</tr></thead><tbody>")
                .Append(Newline)
            for stage in app.Stages {
                sb
                    .Append("<tr><td>")
                    .Append(Encode(stage.Stage))
                    .Append("</td>")
                    .Append("<td>")
                    .Append(Encode(stage.Status))
                    .Append("</td>")
                    .Append("<td>")
                    .Append(stage.ArtifactCount.ToString(CultureInfo.InvariantCulture))
                    .Append("</td></tr>")
                    .Append(Newline)
            }
            sb.Append("</tbody></table>").Append(Newline)
            if app.Artifacts.Count > 0 {
                sb.Append("<p class=\"artifact-h\">triage artifacts</p>").Append(Newline)
                sb.Append("<ul class=\"artifacts\">").Append(Newline)
                for artifact in app.Artifacts {
                    let href = ResolveArtifactHref(model.RunDir, outputDir, artifact)
                    sb
                        .Append("<li><a href=\"")
                        .Append(Encode(EncodeUriPath(href)))
                        .Append("\">")
                        .Append(Encode(artifact))
                        .Append("</a></li>")
                        .Append(Newline)
                }
                sb.Append("</ul>").Append(Newline)
            }
            sb.Append("</article>").Append(Newline)
        }
        sb.Append("</section>").Append(Newline)
    }

    private func AppendMetaLine(sb StringBuilder, label string, value string?) {
        sb
            .Append("<p class=\"meta-line\"><span class=\"k\">")
            .Append(Encode(label))
            .Append("</span> ")
            .Append("<span class=\"v\">")
            .Append(Encode(value))
            .Append("</span></p>")
            .Append(Newline)
    }

    private func AppendScript(sb StringBuilder) {
        sb.Append("<script>").Append(Newline)
        sb.Append(Js)
        sb.Append("</script>").Append(Newline)
    }

    private func FormatDiagnostic(diagnostic TriageDiagnostic?) string? {
        if diagnostic == nil {
            return nil
        }
        let id = diagnostic.Id ?? string.Empty
        let message = diagnostic.Message ?? string.Empty
        if id.Length == 0 {
            return message
        }
        return if message.Length == 0 {
            id
        } else {
            id + ": " + message
        }
    }

    private func FormatLocation(location TriageSourceLocation?) string? {
        if location == nil {
            return nil
        }
        let file = (location.CsFile ?? location.GsFile)!!
        if string.IsNullOrEmpty(file) {
            return nil
        }
        let line = if location.CsFile != nil {
            location.CsLine
        } else {
            location.GsLine
        }
        let column = if location.CsFile != nil {
            location.CsColumn
        } else {
            location.GsColumn
        }
        let sb = StringBuilder(file)
        if (line != nil) {
            sb.Append(':').Append(line.ToString(CultureInfo.InvariantCulture))
            if (column != nil) {
                sb.Append(':').Append(column.ToString(CultureInfo.InvariantCulture))
            }
        }
        return sb.ToString()
    }

    private func EncodeUriPath(relative string) string {
        if string.IsNullOrEmpty(relative) {
            return relative
        }
        return string.Join("/", relative.Split('/').Select(Uri.EscapeDataString))
    }

    /// Resolves a triage-artifact path (stored relative to [`runDir`](paramref)
    /// in `run.json`) to a link that is valid relative to
    /// [`outputDir`](paramref), the directory `report.html` is actually
    /// written into. Uses (cref:Path.GetRelativePath(string, string)) so it
    /// works for any relationship between the two directories (parent, sibling,
    /// nested, or the same directory) and normalizes the result to forward
    /// slashes for use as a URI path.
    /// @param runDir The absolute run directory the artifact path is relative to.
    /// @param outputDir The absolute directory the document is written into.
    /// @param artifactRelative The run-relative artifact path from `run.json`.
    /// @returns The href, relative to [`outputDir`](paramref), with forward-slash separators.
    private func ResolveArtifactHref(runDir string, outputDir string?, artifactRelative string) string {
        let absoluteArtifact = Path.GetFullPath(
            Path.Combine(runDir, artifactRelative.Replace('/', Path.DirectorySeparatorChar))
        )
        let relativeToOutput = Path.GetRelativePath(outputDir!!, absoluteArtifact)
        return relativeToOutput.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/')
    }

    /// Assigns each app a unique HTML id fragment (used for both the matrix's
    /// `href="#app-…"` and the detail `id="app-…"`) so the anchors
    /// always resolve. (cref:Slug) folds case and collapses every
    /// non-alphanumeric run to a single '-', so distinct app ids (e.g.
    /// `corpus/L1-Console` and `corpus/l1.console`) can collide;
    /// on collision this appends the app's ordinal index in
    /// (cref:ReportModel.Apps) (already ordinal-sorted, so stable
    /// across runs) and keeps incrementing until the id is free, which also
    /// covers 3-way-plus collisions.
    private func BuildSlugMap(model ReportModel) Dictionary[string, string] {
        let slugs = Dictionary[string, string](StringComparer.Ordinal)
        let seen = HashSet[string](StringComparer.Ordinal)
        for var i = 0; i < model.Apps.Count; i++ {
            let appId = model.Apps[i].AppId
            let baseSlug = Slug(appId)
            var candidate = baseSlug
            var suffix = i
            while !seen.Add(candidate) {
                candidate = baseSlug + "-" + suffix.ToString(CultureInfo.InvariantCulture)
                suffix++
            }
            slugs[appId] = candidate
        }
        return slugs
    }

    private func Slug(value string) string {
        if string.IsNullOrEmpty(value) {
            return "app"
        }
        let sb = StringBuilder(value.Length)
        for c in value {
            if char.IsLetterOrDigit(c) {
                sb.Append(char.ToLowerInvariant(c))
            } else {
                sb.Append('-')
            }
        }
        return sb.ToString()
    }
}
