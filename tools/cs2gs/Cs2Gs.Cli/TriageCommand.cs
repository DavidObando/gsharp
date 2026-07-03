// <copyright file="TriageCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Cli;

/// <summary>
/// The <c>cs2gs triage</c> verb family (ADR-0138): joins a run's fingerprinted
/// triage artifacts against the checked-in gap ledger
/// (<c>tools/cs2gs/triage/gaps.json</c>) and drives the automated
/// gap→GitHub-issue workflow via the <c>gh</c> CLI.
/// <list type="bullet">
/// <item><c>triage list --run &lt;dir&gt;</c> — classify NEW / KNOWN / REGRESSED / STALE (read-only).</item>
/// <item><c>triage file-issues --run &lt;dir&gt; [--file] [--limit N] [--milestone M]</c> —
/// for NEW fingerprints, cluster by (diagnostic id, construct kind), file one
/// issue per cluster via <c>gh issue create</c>, and append ledger rows.
/// Dry-run by default; <c>--file</c> actually files.</item>
/// <item><c>triage sync [--write]</c> — reconcile ledger statuses against
/// GitHub issue states; flipping to <c>resolved</c> requires an
/// <c>Issue&lt;N&gt;</c> regression test (or <c>--no-test-reason</c>).</item>
/// </list>
/// </summary>
internal static class TriageCommand
{
    /// <summary>The per-invocation cap on filed issues (root-cause clusters), overridable via <c>--limit</c>.</summary>
    private const int DefaultFileLimit = 10;

    /// <summary>
    /// Runs the verb.
    /// </summary>
    /// <param name="args">The verb arguments; the first is the subcommand.</param>
    /// <returns>0 on success/clean, 1 when NEW or REGRESSED fingerprints exist, 2 on tool error.</returns>
    public static int Run(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("cs2gs triage: expected a subcommand (list | file-issues | sync).");
            return 2;
        }

        string sub = args[0];
        string[] rest = args.Skip(1).ToArray();
        return sub switch
        {
            "list" => RunList(rest),
            "file-issues" => RunFileIssues(rest),
            "sync" => RunSync(rest),
            _ => UnknownSubcommand(sub),
        };
    }

    /// <summary>
    /// Reports an unknown subcommand.
    /// </summary>
    /// <param name="sub">The subcommand text.</param>
    /// <returns>Always 2.</returns>
    private static int UnknownSubcommand(string sub)
    {
        Console.Error.WriteLine($"cs2gs triage: unknown subcommand '{sub}' (expected list | file-issues | sync).");
        return 2;
    }

    /// <summary>
    /// The <c>list</c> subcommand: classify a run against the ledger.
    /// </summary>
    /// <param name="args">The subcommand arguments.</param>
    /// <returns>0 when clean, 1 when NEW or REGRESSED exist, 2 on error.</returns>
    private static int RunList(string[] args)
    {
        string runDir = null, gapsPath = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--run" when i + 1 < args.Length:
                    runDir = args[++i];
                    break;
                case "--gaps" when i + 1 < args.Length:
                    gapsPath = args[++i];
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs triage list: unknown option '{args[i]}'.");
                    return 2;
            }
        }

        if (!TryResolveRunAndLedger(ref runDir, ref gapsPath, out GapLedger ledger))
        {
            return 2;
        }

        IReadOnlyList<TriageArtifact> artifacts = GapLedger.LoadRunArtifacts(runDir);
        BaselineClassification classification = ledger.Classify(artifacts, fullCorpus: true);

        Console.WriteLine($"run: {runDir}");
        Console.WriteLine(
            $"fingerprints: {classification.Known.Count} known, {classification.New.Count} new, " +
            $"{classification.Regressed.Count} regressed, {classification.Stale.Count} stale.");
        foreach (TriageArtifact artifact in classification.New)
        {
            Console.WriteLine($"  NEW       {Describe(artifact)}");
        }

        foreach (TriageArtifact artifact in classification.Regressed)
        {
            Console.WriteLine($"  REGRESSED {Describe(artifact)}");
        }

        foreach (TriageArtifact artifact in classification.Known)
        {
            GapLedgerEntry entry = ledger.Entries.First(e => e.Fingerprint == artifact.Fingerprint);
            Console.WriteLine($"  KNOWN #{entry.Issue,-5} {Describe(artifact)}");
        }

        foreach (GapLedgerEntry entry in classification.Stale)
        {
            Console.WriteLine($"  STALE #{entry.Issue,-5} {entry.Fingerprint} {entry.Stage} {entry.DiagnosticId}");
        }

        return classification.PassesGate ? 0 : 1;
    }

    /// <summary>
    /// The <c>file-issues</c> subcommand: file NEW fingerprints as GitHub
    /// issues (clustered by root cause) and append ledger rows.
    /// </summary>
    /// <param name="args">The subcommand arguments.</param>
    /// <returns>0 on success (including nothing to file), 2 on error.</returns>
    private static int RunFileIssues(string[] args)
    {
        string runDir = null, gapsPath = null, milestone = null;
        bool file = false;
        int limit = DefaultFileLimit;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--run" when i + 1 < args.Length:
                    runDir = args[++i];
                    break;
                case "--gaps" when i + 1 < args.Length:
                    gapsPath = args[++i];
                    break;
                case "--milestone" when i + 1 < args.Length:
                    milestone = args[++i];
                    break;
                case "--limit" when i + 1 < args.Length:
                    limit = int.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "--file":
                    file = true;
                    break;
                case "--dry-run":
                    file = false;
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs triage file-issues: unknown option '{args[i]}'.");
                    return 2;
            }
        }

        if (!TryResolveRunAndLedger(ref runDir, ref gapsPath, out GapLedger ledger))
        {
            return 2;
        }

        IReadOnlyList<TriageArtifact> artifacts = GapLedger.LoadRunArtifacts(runDir);
        BaselineClassification classification = ledger.Classify(artifacts, fullCorpus: false);
        if (classification.New.Count == 0)
        {
            Console.WriteLine("cs2gs triage: no new fingerprints; nothing to file.");
            return 0;
        }

        // One issue per root-cause cluster: N fingerprints sharing a diagnostic
        // id + construct kind are almost always one compiler gap fanned out
        // across call sites (the Oahu compile run produced 56 artifacts for a
        // handful of causes). The primary fingerprint carries the issue; the
        // rest are ledgered as superseded-by so the gate treats them as KNOWN.
        List<List<TriageArtifact>> clusters = classification.New
            .GroupBy(a => (a.Diagnostic?.Id, a.OffendingCSharpConstruct?.Kind, a.Stage))
            .Select(g => g.ToList())
            .OrderBy(c => c[0].Fingerprint, StringComparer.Ordinal)
            .ToList();

        Console.WriteLine($"cs2gs triage: {classification.New.Count} new fingerprints in {clusters.Count} clusters" +
            (clusters.Count > limit ? $" (capped at {limit} this invocation)" : string.Empty) +
            (file ? "." : " — DRY RUN (pass --file to create issues)."));

        foreach (List<TriageArtifact> cluster in clusters.Take(limit))
        {
            TriageArtifact primary = cluster[0];
            string title = primary.SuggestedIssue?.Title
                ?? $"[cs2gs] {primary.Diagnostic?.Id} {primary.Stage} gap ({primary.OffendingCSharpConstruct?.Kind})";
            List<string> labels = (primary.SuggestedIssue?.Labels ?? new List<string> { "Oats", "bug" }).ToList();
            string stageLabel = primary.Stage switch
            {
                "compile" => "gap:compile",
                "ilverify" => "gap:ilverify",
                "test-parity" => "gap:parity",
                _ => "gap:translate",
            };
            if (!labels.Contains(stageLabel))
            {
                labels.Add(stageLabel);
            }

            string body = BuildIssueBody(primary, cluster);

            Console.WriteLine($"  cluster {primary.Diagnostic?.Id}/{primary.OffendingCSharpConstruct?.Kind} " +
                $"({cluster.Count} fingerprints): {title}");

            int issueNumber = 0;
            if (file)
            {
                // Belt-and-suspenders dedup: every filed body embeds its
                // fingerprints, so a search hit means it was already filed.
                if (TryFindExistingIssue(primary.Fingerprint, out int existing))
                {
                    Console.WriteLine($"    already filed as #{existing}; ledgering without creating.");
                    issueNumber = existing;
                }
                else if (!TryCreateIssue(title, body, labels, milestone, out issueNumber))
                {
                    Console.Error.WriteLine("    gh issue create failed; stopping.");
                    return 2;
                }
                else
                {
                    Console.WriteLine($"    filed #{issueNumber}.");
                }
            }

            foreach (TriageArtifact artifact in cluster)
            {
                var entry = new GapLedgerEntry
                {
                    Fingerprint = artifact.Fingerprint,
                    Issue = file ? issueNumber : null,
                    Status = artifact == primary ? GapLedgerEntry.StatusOpen : GapLedgerEntry.StatusSuperseded,
                    SupersededBy = artifact == primary ? null : primary.Fingerprint,
                    Title = title,
                    Stage = artifact.Stage,
                    DiagnosticId = artifact.Diagnostic?.Id,
                    ConstructKind = artifact.OffendingCSharpConstruct?.Kind,
                    FirstSeenRun = artifact.RunId,
                    Apps = new List<string> { artifact.CorpusAppId },
                };
                if (file)
                {
                    ledger.Entries.Add(entry);
                }
                else
                {
                    Console.WriteLine($"    would ledger {entry.Status}: {artifact.Fingerprint}");
                }
            }
        }

        if (file)
        {
            ledger.Save(gapsPath);
            Console.WriteLine($"cs2gs triage: ledger updated at {gapsPath}.");
        }

        return 0;
    }

    /// <summary>
    /// The <c>sync</c> subcommand: reconcile ledger statuses with GitHub.
    /// </summary>
    /// <param name="args">The subcommand arguments.</param>
    /// <returns>0 on success, 2 on error.</returns>
    private static int RunSync(string[] args)
    {
        string gapsPath = null, noTestReason = null;
        bool write = false;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--gaps" when i + 1 < args.Length:
                    gapsPath = args[++i];
                    break;
                case "--write":
                    write = true;
                    break;
                case "--no-test-reason" when i + 1 < args.Length:
                    noTestReason = args[++i];
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs triage sync: unknown option '{args[i]}'.");
                    return 2;
            }
        }

        gapsPath ??= DefaultGapsPath();
        if (gapsPath is null)
        {
            Console.Error.WriteLine("cs2gs triage: GSharp.sln not found above the current directory; pass --gaps.");
            return 2;
        }

        GapLedger ledger = GapLedger.Load(gapsPath);
        bool changed = false;
        foreach (GapLedgerEntry entry in ledger.Entries.Where(e =>
                     e.Issue is not null && e.Status == GapLedgerEntry.StatusOpen))
        {
            if (!TryGetIssueState(entry.Issue.Value, out string state))
            {
                Console.Error.WriteLine($"  #{entry.Issue}: gh issue view failed; skipping.");
                continue;
            }

            if (!string.Equals(state, "CLOSED", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            bool hasTest = HasRegressionTest(entry.Issue.Value);
            if (!hasTest && string.IsNullOrEmpty(noTestReason))
            {
                Console.WriteLine($"  #{entry.Issue} is closed but no Issue{entry.Issue}* regression test was " +
                    "found; add one (or pass --no-test-reason) before flipping to resolved.");
                continue;
            }

            Console.WriteLine($"  #{entry.Issue} closed → {entry.Fingerprint} resolved" +
                (hasTest ? " (regression test present)" : $" (no test: {noTestReason})") +
                (write ? string.Empty : " [dry-run]"));
            if (write)
            {
                entry.Status = GapLedgerEntry.StatusResolved;
                if (!hasTest)
                {
                    entry.Notes = string.IsNullOrEmpty(entry.Notes)
                        ? $"resolved without regression test: {noTestReason}"
                        : entry.Notes + $"; resolved without regression test: {noTestReason}";
                }

                changed = true;
            }
        }

        if (changed)
        {
            ledger.Save(gapsPath);
            Console.WriteLine($"cs2gs triage: ledger updated at {gapsPath}.");
        }
        else if (!write)
        {
            Console.WriteLine("cs2gs triage: dry-run complete (pass --write to apply).");
        }

        return 0;
    }

    /// <summary>
    /// Builds the issue body from the artifact's pre-rendered suggestion plus
    /// the cluster's provenance and the definition-of-done checklist.
    /// </summary>
    /// <param name="primary">The cluster's primary artifact.</param>
    /// <param name="cluster">All artifacts in the cluster.</param>
    /// <returns>The markdown body.</returns>
    private static string BuildIssueBody(TriageArtifact primary, IReadOnlyList<TriageArtifact> cluster)
    {
        var sb = new StringBuilder();
        sb.AppendLine(primary.SuggestedIssue?.Body ?? primary.Diagnostic?.Message ?? string.Empty);
        sb.AppendLine();
        sb.AppendLine("## Provenance (auto-filed by `cs2gs triage file-issues`)");
        foreach (TriageArtifact artifact in cluster)
        {
            sb.AppendLine($"- `{artifact.Fingerprint}` — {artifact.Stage} {artifact.Diagnostic?.Id} " +
                $"in `{artifact.CorpusAppId}` (run `{artifact.RunId}`, gsc {artifact.GscVersion})");
        }

        sb.AppendLine();
        sb.AppendLine("## Definition of done");
        sb.AppendLine("- [ ] Fix + `Issue<N>*.cs` regression test");
        sb.AppendLine("- [ ] `tools/cs2gs/triage/gaps.json` entry flipped to `resolved` (`cs2gs triage sync --write`)");
        sb.AppendLine("- [ ] Corpus re-run confirms the fingerprint no longer reproduces");
        return sb.ToString();
    }

    /// <summary>
    /// Renders a one-line artifact description for list output.
    /// </summary>
    /// <param name="artifact">The artifact.</param>
    /// <returns>The description.</returns>
    private static string Describe(TriageArtifact artifact) =>
        $"{artifact.Fingerprint} {artifact.Stage} {artifact.Diagnostic?.Id} " +
        $"{artifact.OffendingCSharpConstruct?.Kind} ({artifact.CorpusAppId})";

    /// <summary>
    /// Resolves and validates the run directory and ledger path, loading the ledger.
    /// </summary>
    /// <param name="runDir">The run directory (validated to contain run.json).</param>
    /// <param name="gapsPath">The ledger path (defaulted from the repo root when omitted).</param>
    /// <param name="ledger">The loaded ledger.</param>
    /// <returns><see langword="true"/> when both resolve.</returns>
    private static bool TryResolveRunAndLedger(ref string runDir, ref string gapsPath, out GapLedger ledger)
    {
        ledger = null;
        if (string.IsNullOrEmpty(runDir) || !File.Exists(Path.Combine(runDir, "run.json")))
        {
            Console.Error.WriteLine("cs2gs triage: --run <dir> pointing at a directory containing run.json is required.");
            return false;
        }

        gapsPath ??= DefaultGapsPath();
        if (gapsPath is null)
        {
            Console.Error.WriteLine("cs2gs triage: GSharp.sln not found above the current directory; pass --gaps.");
            return false;
        }

        ledger = GapLedger.Load(gapsPath);
        return true;
    }

    /// <summary>
    /// Resolves the default ledger path by walking up to the repo root.
    /// </summary>
    /// <returns>The ledger path, or <see langword="null"/> when no repo root is found.</returns>
    private static string DefaultGapsPath()
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return Path.Combine(dir.FullName, GapLedger.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar));
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// Searches GitHub for an already-filed issue embedding the fingerprint.
    /// </summary>
    /// <param name="fingerprint">The triage fingerprint.</param>
    /// <param name="issueNumber">The found issue number.</param>
    /// <returns><see langword="true"/> when an existing issue was found.</returns>
    private static bool TryFindExistingIssue(string fingerprint, out int issueNumber)
    {
        issueNumber = 0;
        (int exit, string stdout) = RunGh(
            "issue", "list", "--state", "all", "--search", fingerprint, "--json", "number", "--limit", "1");
        if (exit != 0)
        {
            return false;
        }

        try
        {
            using JsonDocument doc = JsonDocument.Parse(stdout);
            if (doc.RootElement.GetArrayLength() > 0)
            {
                issueNumber = doc.RootElement[0].GetProperty("number").GetInt32();
                return true;
            }
        }
        catch (JsonException)
        {
        }

        return false;
    }

    /// <summary>
    /// Creates a GitHub issue via <c>gh issue create</c>.
    /// </summary>
    /// <param name="title">The issue title.</param>
    /// <param name="body">The issue body markdown.</param>
    /// <param name="labels">The labels to apply.</param>
    /// <param name="milestone">The optional milestone.</param>
    /// <param name="issueNumber">The created issue number.</param>
    /// <returns><see langword="true"/> on success.</returns>
    private static bool TryCreateIssue(string title, string body, IReadOnlyList<string> labels, string milestone, out int issueNumber)
    {
        issueNumber = 0;
        string bodyFile = Path.GetTempFileName();
        try
        {
            File.WriteAllText(bodyFile, body);
            var ghArgs = new List<string> { "issue", "create", "--title", title, "--body-file", bodyFile };
            foreach (string label in labels)
            {
                ghArgs.Add("--label");
                ghArgs.Add(label);
            }

            if (!string.IsNullOrEmpty(milestone))
            {
                ghArgs.Add("--milestone");
                ghArgs.Add(milestone);
            }

            (int exit, string stdout) = RunGh(ghArgs.ToArray());
            if (exit != 0)
            {
                return false;
            }

            // gh prints the created issue URL; the number is the last segment.
            string last = stdout.Trim().Split('/').LastOrDefault();
            return int.TryParse(last, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out issueNumber);
        }
        finally
        {
            File.Delete(bodyFile);
        }
    }

    /// <summary>
    /// Reads an issue's open/closed state via <c>gh issue view</c>.
    /// </summary>
    /// <param name="issue">The issue number.</param>
    /// <param name="state">The state (<c>OPEN</c>/<c>CLOSED</c>).</param>
    /// <returns><see langword="true"/> on success.</returns>
    private static bool TryGetIssueState(int issue, out string state)
    {
        state = null;
        (int exit, string stdout) = RunGh(
            "issue", "view", issue.ToString(System.Globalization.CultureInfo.InvariantCulture), "--json", "state");
        if (exit != 0)
        {
            return false;
        }

        try
        {
            using JsonDocument doc = JsonDocument.Parse(stdout);
            state = doc.RootElement.GetProperty("state").GetString();
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// Determines whether an <c>Issue&lt;N&gt;</c>-named regression test exists
    /// under the repo's test trees.
    /// </summary>
    /// <param name="issue">The issue number.</param>
    /// <returns><see langword="true"/> when a matching test file exists.</returns>
    private static bool HasRegressionTest(int issue)
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
        {
            dir = dir.Parent;
        }

        if (dir is null)
        {
            return false;
        }

        string needle = "Issue" + issue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new[] { Path.Combine(dir.FullName, "tools", "cs2gs", "Cs2Gs.Tests"), Path.Combine(dir.FullName, "test") }
            .Where(Directory.Exists)
            .SelectMany(root => Directory.EnumerateFiles(root, "Issue*.cs", SearchOption.AllDirectories))
            .Any(f => Path.GetFileName(f).StartsWith(needle, StringComparison.Ordinal)
                && !char.IsDigit(Path.GetFileName(f)[needle.Length]));
    }

    /// <summary>
    /// Runs the <c>gh</c> CLI with the given arguments.
    /// </summary>
    /// <param name="args">The gh arguments.</param>
    /// <returns>The exit code and stdout.</returns>
    private static (int Exit, string Stdout) RunGh(params string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "gh",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        try
        {
            using Process process = Process.Start(psi);
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0 && !string.IsNullOrWhiteSpace(stderr))
            {
                Console.Error.WriteLine("    gh: " + stderr.Trim());
            }

            return (process.ExitCode, stdout);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            Console.Error.WriteLine("    gh CLI not found on PATH.");
            return (127, string.Empty);
        }
    }
}
