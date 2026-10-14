// <copyright file="TriageCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Cli

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Text
import System.Text.Json

/// The `cs2gs triage` verb family (ADR-0138): joins a run's fingerprinted
/// triage artifacts against the checked-in gap ledger
/// (`tools/cs2gs/triage/gaps.json`) and drives the automated
/// gap→GitHub-issue workflow via the `gh` CLI.
/// - `triage list --run <dir>` — classify NEW / KNOWN / REGRESSED / STALE (read-only).
/// - `triage file-issues --run <dir> [--file] [--limit N] [--milestone M]` — for NEW fingerprints,
/// cluster by (diagnostic id, construct kind), file one issue per cluster via `gh issue create`, and
/// append ledger rows. Dry-run by default; `--file` actually files.
/// - `triage sync [--write]` — reconcile ledger statuses against GitHub issue states; flipping to
/// `resolved` requires an `Issue<N>` regression test (or `--no-test-reason`).
internal shared class TriageCommand {
    /// The per-invocation cap on filed issues (root-cause clusters), overridable via `--limit`.
    private const DefaultFileLimit int32 = 10

    /// Runs the verb.
    /// @param args The verb arguments; the first is the subcommand.
    /// @returns 0 on success/clean, 1 when NEW or REGRESSED fingerprints exist, 2 on tool error.
    func Run(args[]string) int32 {
        if args.Length == 0 {
            Console.Error.WriteLine("cs2gs triage: expected a subcommand (list | file-issues | sync).")
            return 2
        }
        let sub = args[0]
        let rest = args.Skip(1).ToArray()
        return switch sub {
            case "list": RunList(rest)
            case "file-issues": RunFileIssues(rest)
            case "sync": RunSync(rest)
            default: UnknownSubcommand(sub)
        }
    }

    /// Reports an unknown subcommand.
    /// @param sub The subcommand text.
    /// @returns Always 2.
    private func UnknownSubcommand(sub string) int32 {
        Console.Error.WriteLine("cs2gs triage: unknown subcommand '$sub' (expected list | file-issues | sync).")
        return 2
    }

    /// The `list` subcommand: classify a run against the ledger.
    /// @param args The subcommand arguments.
    /// @returns 0 when clean, 1 when NEW or REGRESSED exist, 2 on error.
    private func RunList(args[]string) int32 {
        var runDir string? = nil
        var gapsPath string? = nil
        for var i = 0; i < args.Length; i++ {
            switch args[i] {
                case "--run" when i + 1 < args.Length {
                    runDir = args[(i += 1)]
                }
                case "--gaps" when i + 1 < args.Length {
                    gapsPath = args[(i += 1)]
                }
                default {
                    Console.Error.WriteLine("cs2gs triage list: unknown option '${args[i]}'.")
                    return 2
                }
            }
        }
        if !TryResolveRunAndLedger(&runDir, &gapsPath, out var ledger) {
            return 2
        }
        let resolvedLedger GapLedger? = ledger!!
        let artifacts = GapLedger.LoadRunArtifacts(runDir)
        let classification = resolvedLedger!!.Classify(artifacts, fullCorpus: true)
        Console.WriteLine("run: $runDir")
        Console.WriteLine(
            "fingerprints: ${classification.Known.Count} known, ${classification.New.Count} new, " +
                "${classification.Regressed.Count} regressed, ${classification.Stale.Count} stale."
        )
        for artifact in classification.New {
            Console.WriteLine("  NEW       ${Describe(artifact)}")
        }
        for artifact in classification.Regressed {
            Console.WriteLine("  REGRESSED ${Describe(artifact)}")
        }
        for artifact in classification.Known {
            let entry = resolvedLedger!!.Entries.First((e GapLedgerEntry) -> e.Fingerprint == artifact.Fingerprint)
            Console.WriteLine("  KNOWN #${entry.Issue,-5} ${Describe(artifact)}")
        }
        for entry in classification.Stale {
            Console.WriteLine("  STALE #${entry.Issue,-5} ${entry.Fingerprint} ${entry.Stage} ${entry.DiagnosticId}")
        }
        return if classification.PassesGate {
            0
        } else {
            1
        }
    }

    /// The `file-issues` subcommand: file NEW fingerprints as GitHub
    /// issues (clustered by root cause) and append ledger rows.
    /// @param args The subcommand arguments.
    /// @returns 0 on success (including nothing to file), 2 on error.
    private func RunFileIssues(args[]string) int32 {
        var runDir string? = nil
        var gapsPath string? = nil
        var milestone string? = nil
        var file = false
        var limit = DefaultFileLimit
        for var i = 0; i < args.Length; i++ {
            switch args[i] {
                case "--run" when i + 1 < args.Length {
                    runDir = args[(i += 1)]
                }
                case "--gaps" when i + 1 < args.Length {
                    gapsPath = args[(i += 1)]
                }
                case "--milestone" when i + 1 < args.Length {
                    milestone = args[(i += 1)]
                }
                case "--limit" when i + 1 < args.Length {
                    limit = int32.Parse(args[(i += 1)], CultureInfo.InvariantCulture)
                }
                case "--file" {
                    file = true
                }
                case "--dry-run" {
                    file = false
                }
                default {
                    Console.Error.WriteLine("cs2gs triage file-issues: unknown option '${args[i]}'.")
                    return 2
                }
            }
        }
        if !TryResolveRunAndLedger(&runDir, &gapsPath, out var ledger) {
            return 2
        }
        let resolvedLedger GapLedger? = ledger!!
        let artifacts = GapLedger.LoadRunArtifacts(runDir)
        let classification = resolvedLedger!!.Classify(artifacts, fullCorpus: false)
        if classification.New.Count == 0 {
            Console.WriteLine("cs2gs triage: no new fingerprints; nothing to file.")
            return 0
        }
        // One issue per root-cause cluster: N fingerprints sharing a diagnostic
        // id + construct kind are almost always one compiler gap fanned out
        // across call sites (the Oahu compile run produced 56 artifacts for a
        // handful of causes). The primary fingerprint carries the issue; the
        // rest are ledgered as superseded-by so the gate treats them as KNOWN.
        let clusters = classification
            .New
            .GroupBy(
            (a TriageArtifact) -> (
                a.Diagnostic?.Id ?? string.Empty,
                a.OffendingCSharpConstruct?.Kind ?? string.Empty,
                a.Stage
            )
        )
            .Select((g IGrouping[(string, string, Stage string), TriageArtifact]) -> g.ToList())
            .OrderBy((c List[TriageArtifact]) -> c[0].Fingerprint, StringComparer.Ordinal)
            .ToList()
        Console.WriteLine(
            "cs2gs triage: ${classification.New.Count} new fingerprints in ${clusters.Count} clusters" +
                (
                if clusters.Count > limit {
                    " (capped at $limit this invocation)"
                } else {
                    string.Empty
                }
            ) +
                (
                if file {
                    "."
                } else {
                    " — DRY RUN (pass --file to create issues)."
                }
            )
        )
        for cluster in clusters.Take(limit) {
            let primary = cluster[0]
            let title = primary
                .SuggestedIssue
                ?.Title ??
                "[cs2gs] ${primary.Diagnostic?.Id} ${primary.Stage} gap (${primary.OffendingCSharpConstruct?.Kind})"
            let labels = (primary.SuggestedIssue?.Labels ?? List[string]{"Oats", "bug"}).ToList()
            let stageLabel = switch primary.Stage {
                case "compile": "gap:compile"
                case "ilverify": "gap:ilverify"
                case "test-parity": "gap:parity"
                default: "gap:translate"
            }
            if !labels.Contains(stageLabel) {
                labels.Add(stageLabel)
            }
            let body = BuildIssueBody(primary, cluster)
            Console.WriteLine(
                "  cluster ${primary.Diagnostic?.Id}/${primary.OffendingCSharpConstruct?.Kind} " +
                    "(${cluster.Count} fingerprints): $title"
            )
            var issueNumber = 0
            if file {
                // Belt-and-suspenders dedup: every filed body embeds its
                // fingerprints, so a search hit means it was already filed.
                if TryFindExistingIssue(primary.Fingerprint, out var existing) {
                    Console.WriteLine("    already filed as #$existing; ledgering without creating.")
                    issueNumber = existing
                } else if !TryCreateIssue(title, body, labels, milestone, out issueNumber) {
                    Console.Error.WriteLine("    gh issue create failed; stopping.")
                    return 2
                } else {
                    Console.WriteLine("    filed #$issueNumber.")
                }
            }
            for artifact in cluster {
                let entry = GapLedgerEntry{
                    Fingerprint: artifact.Fingerprint,
                    Issue: if file {
                        issueNumber
                    } else {
                        nil
                    },
                    Status: if artifact == primary {
                        GapLedgerEntry.StatusOpen
                    } else {
                        GapLedgerEntry.StatusSuperseded
                    },
                    SupersededBy: (
                        if artifact == primary {
                            default(string?)
                        } else {
                            primary.Fingerprint
                        }
                    )!!,
                    Title: title,
                    Stage: artifact.Stage,
                    DiagnosticId: artifact.Diagnostic?.Id!!,
                    ConstructKind: artifact.OffendingCSharpConstruct?.Kind!!,
                    FirstSeenRun: artifact.RunId,
                    Apps: List[string]{artifact.CorpusAppId}
                }
                if file {
                    resolvedLedger!!.Entries.Add(entry)
                } else {
                    Console.WriteLine("    would ledger ${entry.Status}: ${artifact.Fingerprint}")
                }
            }
        }
        if file {
            resolvedLedger!!.Save(gapsPath)
            Console.WriteLine("cs2gs triage: ledger updated at $gapsPath.")
        }
        return 0
    }

    /// The `sync` subcommand: reconcile ledger statuses with GitHub.
    /// @param args The subcommand arguments.
    /// @returns 0 on success, 2 on error.
    private func RunSync(args[]string) int32 {
        var gapsPath string? = nil
        var noTestReason string? = nil
        var write = false
        for var i = 0; i < args.Length; i++ {
            switch args[i] {
                case "--gaps" when i + 1 < args.Length {
                    gapsPath = args[(i += 1)]
                }
                case "--write" {
                    write = true
                }
                case "--no-test-reason" when i + 1 < args.Length {
                    noTestReason = args[(i += 1)]
                }
                default {
                    Console.Error.WriteLine("cs2gs triage sync: unknown option '${args[i]}'.")
                    return 2
                }
            }
        }
        gapsPath ??= DefaultGapsPath()
        if gapsPath == nil {
            Console.Error.WriteLine(
                "cs2gs triage: repository root (GSharp.sln or GSharp.slnx) not found above the current directory; pass --gaps."
            )
            return 2
        }
        let ledger = GapLedger.Load(gapsPath)
        var changed = false
        for entry in ledger.Entries.Where(
            (e GapLedgerEntry) -> e.Issue != nil && e.Status == GapLedgerEntry.StatusOpen
        ) {
            if !TryGetIssueState(entry.Issue!!, out var state) {
                Console.Error.WriteLine("  #${entry.Issue}: gh issue view failed; skipping.")
                continue
            }
            if !string.Equals(state, "CLOSED", StringComparison.OrdinalIgnoreCase) {
                continue
            }
            let hasTest = HasRegressionTest(entry.Issue!!)
            if !hasTest && string.IsNullOrEmpty(noTestReason) {
                Console.WriteLine(
                    "  #${entry.Issue} is closed but no Issue${entry.Issue}* regression test was " +
                        "found; add one (or pass --no-test-reason) before flipping to resolved."
                )
                continue
            }
            Console.WriteLine(
                "  #${entry.Issue} closed → ${entry.Fingerprint} resolved" +
                    (
                    if hasTest {
                        " (regression test present)"
                    } else {
                        " (no test: $noTestReason)"
                    }
                ) +
                    (
                    if write {
                        string.Empty
                    } else {
                        " [dry-run]"
                    }
                )
            )
            if write {
                entry.Status = GapLedgerEntry.StatusResolved
                if !hasTest {
                    entry.Notes = if string.IsNullOrEmpty(entry.Notes) {
                        "resolved without regression test: $noTestReason"
                    } else {
                        entry.Notes + "; resolved without regression test: $noTestReason"
                    }
                }
                changed = true
            }
        }
        if changed {
            ledger.Save(gapsPath)
            Console.WriteLine("cs2gs triage: ledger updated at $gapsPath.")
        } else if !write {
            Console.WriteLine("cs2gs triage: dry-run complete (pass --write to apply).")
        }
        return 0
    }

    /// Builds the issue body from the artifact's pre-rendered suggestion plus
    /// the cluster's provenance and the definition-of-done checklist.
    /// @param primary The cluster's primary artifact.
    /// @param cluster All artifacts in the cluster.
    /// @returns The markdown body.
    private func BuildIssueBody(primary TriageArtifact, cluster IReadOnlyList[TriageArtifact]) string {
        let sb = StringBuilder()
        sb.AppendLine(primary.SuggestedIssue?.Body ?? primary.Diagnostic?.Message ?? string.Empty)
        sb.AppendLine()
        sb.AppendLine("## Provenance (auto-filed by `cs2gs triage file-issues`)")
        for artifact in cluster {
            sb.AppendLine(
                "- `${artifact.Fingerprint}` — ${artifact.Stage} ${artifact.Diagnostic?.Id} " +
                    "in `${artifact.CorpusAppId}` (run `${artifact.RunId}`, gsc ${artifact.GscVersion})"
            )
        }
        sb.AppendLine()
        sb.AppendLine("## Definition of done")
        sb.AppendLine("- [ ] Fix + `Issue<N>*.cs` regression test")
        sb.AppendLine("- [ ] `tools/cs2gs/triage/gaps.json` entry flipped to `resolved` (`cs2gs triage sync --write`)")
        sb.AppendLine("- [ ] Corpus re-run confirms the fingerprint no longer reproduces")
        return sb.ToString()
    }

    /// Renders a one-line artifact description for list output.
    /// @param artifact The artifact.
    /// @returns The description.
    private func Describe(
        artifact TriageArtifact
    ) string -> "${artifact.Fingerprint} ${artifact.Stage} ${artifact.Diagnostic?.Id} " +
        "${artifact.OffendingCSharpConstruct?.Kind} (${artifact.CorpusAppId})"

    /// Resolves and validates the run directory and ledger path, loading the ledger.
    /// @param runDir The run directory (validated to contain run.json).
    /// @param gapsPath The ledger path (defaulted from the repo root when omitted).
    /// @param ledger The loaded ledger.
    /// @returns `true` when both resolve.
    private func TryResolveRunAndLedger(ref runDir string?, ref gapsPath string?, out ledger GapLedger?) bool {
        ledger = nil
        if string.IsNullOrEmpty(runDir) || !File.Exists(Path.Combine(runDir!!, "run.json")) {
            Console.Error.WriteLine(
                "cs2gs triage: --run <dir> pointing at a directory containing run.json is required."
            )
            return false
        }
        gapsPath ??= DefaultGapsPath()
        if gapsPath == nil {
            Console.Error.WriteLine(
                "cs2gs triage: repository root (GSharp.sln or GSharp.slnx) not found above the current directory; pass --gaps."
            )
            return false
        }
        ledger = GapLedger.Load(gapsPath)
        return true
    }

    /// Resolves the default ledger path by walking up to the repo root.
    /// @returns The ledger path, or `null` when no repo root is found.
    private func DefaultGapsPath() string? {
        var dir DirectoryInfo? = DirectoryInfo(Directory.GetCurrentDirectory())
        while dir != nil {
            if RepositoryRootMarker.IsRoot(dir.FullName) {
                return Path.Combine(dir.FullName, GapLedger.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar))
            }
            dir = dir.Parent
        }
        return nil
    }

    /// Searches GitHub for an already-filed issue embedding the fingerprint.
    /// @param fingerprint The triage fingerprint.
    /// @param issueNumber The found issue number.
    /// @returns `true` when an existing issue was found.
    private func TryFindExistingIssue(fingerprint string, out issueNumber int32) bool {
        issueNumber = 0
        let (exit, stdout) = RunGh(
            "issue",
            "list",
            "--state",
            "all",
            "--search",
            fingerprint,
            "--json",
            "number",
            "--limit",
            "1"
        )
        if exit != 0 {
            return false
        }
        try {
            using let doc = JsonDocument.Parse(stdout)
            if doc.RootElement.GetArrayLength() > 0 {
                issueNumber = doc.RootElement[0].GetProperty("number").GetInt32()
                return true
            }
        } catch (JsonException) { }
        return false
    }

    /// Creates a GitHub issue via `gh issue create`.
    /// @param title The issue title.
    /// @param body The issue body markdown.
    /// @param labels The labels to apply.
    /// @param milestone The optional milestone.
    /// @param issueNumber The created issue number.
    /// @returns `true` on success.
    private func TryCreateIssue(
        title string,
        body string,
        labels IReadOnlyList[string],
        milestone string?,
        out issueNumber int32
    ) bool {
        issueNumber = 0
        let bodyFile = Path.GetTempFileName()
        try {
            File.WriteAllText(bodyFile, body)
            let ghArgs = List[string]{"issue", "create", "--title", title, "--body-file", bodyFile}
            for label in labels {
                ghArgs.Add("--label")
                ghArgs.Add(label)
            }
            if !string.IsNullOrEmpty(milestone) {
                ghArgs.Add("--milestone")
                ghArgs.Add(milestone)
            }
            let (exit, stdout) = RunGh(ghArgs.ToArray())
            if exit != 0 {
                return false
            }
            // gh prints the created issue URL; the number is the last segment.
            let last string? = stdout.Trim().Split('/').LastOrDefault()
            return int32.TryParse(last, NumberStyles.Integer, CultureInfo.InvariantCulture, out issueNumber)
        } finally {
            File.Delete(bodyFile)
        }
    }

    /// Reads an issue's open/closed state via `gh issue view`.
    /// @param issue The issue number.
    /// @param state The state (`OPEN`/`CLOSED`).
    /// @returns `true` on success.
    private func TryGetIssueState(issue int32, out state string?) bool {
        state = nil
        let (exit, stdout) = RunGh("issue", "view", issue.ToString(CultureInfo.InvariantCulture), "--json", "state")
        if exit != 0 {
            return false
        }
        try {
            using let doc = JsonDocument.Parse(stdout)
            state = doc.RootElement.GetProperty("state").GetString()
            return true
        } catch (JsonException) {
            return false
        }
    }

    /// Determines whether an `Issue<N>`-named regression test exists
    /// under the repo's test trees.
    /// @param issue The issue number.
    /// @returns `true` when a matching test file exists.
    private func HasRegressionTest(issue int32) bool {
        var dir DirectoryInfo? = DirectoryInfo(Directory.GetCurrentDirectory())
        while dir != nil && !RepositoryRootMarker.IsRoot(dir.FullName) {
            dir = dir.Parent
        }
        if dir == nil {
            return false
        }
        let needle = "Issue" + issue.ToString(CultureInfo.InvariantCulture)
        let rootDirectory = dir.FullName
        for root in[]string{
            Path.Combine(rootDirectory, "tools", "cs2gs", "Cs2Gs.Tests"),
            Path.Combine(rootDirectory, "test")
        } {
            if !Directory.Exists(root) {
                continue
            }
            for file in Directory.EnumerateFiles(root, "Issue*.cs", SearchOption.AllDirectories) {
                let fileName = Path.GetFileName(file)
                if fileName.StartsWith(needle, StringComparison.Ordinal) &&
                    fileName.Length > needle.Length &&
                    !char.IsDigit(fileName[needle.Length]) {
                    return true
                }
            }
        }
        return false
    }

    /// Runs the `gh` CLI with the given arguments.
    /// @param args The gh arguments.
    /// @returns The exit code and stdout.
    private func RunGh(args ...string)(Exit int32, Stdout string) {
        let psi = ProcessStartInfo{
            FileName: "gh",
            RedirectStandardOutput: true,
            RedirectStandardError: true,
            UseShellExecute: false
        }
        for arg in args {
            psi.ArgumentList.Add(arg)
        }
        try {
            using let process Process? = Process.Start(psi)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            if process!!.ExitCode != 0 && !string.IsNullOrWhiteSpace(stderr) {
                Console.Error.WriteLine("    gh: " + stderr.Trim())
            }
            return (process!!.ExitCode, stdout)
        } catch (Win32Exception) {
            Console.Error.WriteLine("    gh CLI not found on PATH.")
            return (127, string.Empty)
        }
    }
}
