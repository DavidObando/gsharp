// <copyright file="ConstructInventory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Translator.Coverage;

/// <summary>
/// The translation disposition of one C# construct (one Roslyn node
/// <c>SyntaxKind</c>) in the construct inventory.
/// </summary>
public enum ConstructStatus
{
    /// <summary>Not yet classified; the ratchet in ConstructInventoryGoldenTests drives this count to zero.</summary>
    Unclassified,

    /// <summary>Translated to a direct canonical G# form (ADR-0115 §B rule required).</summary>
    Translated,

    /// <summary>Translated by lowering to a different canonical G# shape (e.g. LINQ query syntax → method chain).</summary>
    Lowered,

    /// <summary>Deliberately not translated; a <see cref="UnsupportedRationale"/> is required.</summary>
    UnsupportedByDesign,

    /// <summary>A known hole with a tracking GitHub issue; the issue link is required.</summary>
    Gap,
}

/// <summary>
/// Why a construct is <see cref="ConstructStatus.UnsupportedByDesign"/>. The
/// taxonomy is the arbitration record for contested classifications
/// (ADR-0138).
/// </summary>
public enum UnsupportedRationale
{
    /// <summary>No rationale (only valid for statuses other than unsupported-by-design).</summary>
    None,

    /// <summary>G# deliberately omits the construct and no mapping is planned (e.g. goto, __makeref).</summary>
    NoGsharpConstruct,

    /// <summary>Resolved before/outside translation by Roslyn parse options (#if, #pragma, #region, ...).</summary>
    Preprocessor,

    /// <summary>Exists for tooling or codegen, not program semantics (interceptors, #line, XML-doc structure).</summary>
    ToolingScope,

    /// <summary>The construct legitimately disappears in canonical G# (e.g. partial-declaration merging).</summary>
    SemanticsErased,

    /// <summary>Representable but consciously postponed; a tracking issue link is required.</summary>
    Deferred,

    /// <summary>The kind is unreachable as parsed C# (compat/error-recovery artifacts).</summary>
    NotReachable,
}

/// <summary>
/// The checked-in classification of every C# node kind
/// (<c>tools/cs2gs/coverage/csharp-construct-inventory.json</c>): load,
/// validation, and the generated human-readable matrix
/// (<c>docs/cs2gs-coverage-matrix.md</c>). ConstructInventoryGoldenTests keeps
/// the inventory, the Roslyn surface, and the generated doc in lockstep.
/// </summary>
public sealed class ConstructInventory
{
    /// <summary>The repo-relative path of the inventory data file.</summary>
    public const string RepoRelativePath = "tools/cs2gs/coverage/csharp-construct-inventory.json";

    /// <summary>The repo-relative path of the generated matrix document.</summary>
    public const string MatrixRepoRelativePath = "docs/cs2gs-coverage-matrix.md";

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// Initializes a new instance of the <see cref="ConstructInventory"/> class.
    /// </summary>
    /// <param name="entries">The inventory rows.</param>
    public ConstructInventory(IReadOnlyList<ConstructEntry> entries)
    {
        this.Entries = entries ?? throw new ArgumentNullException(nameof(entries));
    }

    /// <summary>Gets the inventory rows.</summary>
    public IReadOnlyList<ConstructEntry> Entries { get; }

    /// <summary>
    /// Loads the inventory from a JSON file.
    /// </summary>
    /// <param name="path">The file path.</param>
    /// <returns>The loaded inventory.</returns>
    public static ConstructInventory Load(string path)
    {
        using FileStream stream = File.OpenRead(path);
        List<ConstructEntry> entries = JsonSerializer.Deserialize<List<ConstructEntry>>(stream, SerializerOptions);
        return new ConstructInventory(entries);
    }

    /// <summary>
    /// Serializes the inventory (sorted by kind) back to JSON text.
    /// </summary>
    /// <returns>The JSON text, LF line endings, trailing newline.</returns>
    public string ToJson()
    {
        List<ConstructEntry> sorted = this.Entries.OrderBy(e => e.Kind, StringComparer.Ordinal).ToList();
        return JsonSerializer.Serialize(sorted, SerializerOptions).Replace("\r\n", "\n") + "\n";
    }

    /// <summary>
    /// Validates the inventory against the live Roslyn surface and the schema
    /// invariants. Fixture existence is validated relative to
    /// <paramref name="repoRoot"/> when a fixture path is present.
    /// </summary>
    /// <param name="repoRoot">The repository root directory.</param>
    /// <returns>The list of violations; empty when valid.</returns>
    public IReadOnlyList<string> Validate(string repoRoot)
    {
        var errors = new List<string>();
        var kinds = new HashSet<string>(StringComparer.Ordinal);
        var surface = new HashSet<string>(RoslynSurface.NodeKindNames(), StringComparer.Ordinal);

        foreach (ConstructEntry entry in this.Entries)
        {
            string kind = entry.Kind ?? "<null>";
            if (!kinds.Add(kind))
            {
                errors.Add($"{kind}: duplicate inventory row.");
            }

            if (!surface.Contains(kind))
            {
                errors.Add($"{kind}: not a node kind on the current Roslyn surface (stale row?).");
            }

            if (string.IsNullOrEmpty(entry.NodeType))
            {
                errors.Add($"{kind}: nodeType is required.");
            }

            bool needsRule = entry.Status is ConstructStatus.Translated or ConstructStatus.Lowered;
            if (needsRule && string.IsNullOrEmpty(entry.Rule))
            {
                errors.Add($"{kind}: status '{entry.Status}' requires a canonical-rule reference.");
            }

            if (entry.Status == ConstructStatus.UnsupportedByDesign && entry.Rationale == UnsupportedRationale.None)
            {
                errors.Add($"{kind}: unsupported-by-design requires a rationale.");
            }

            if (entry.Status != ConstructStatus.UnsupportedByDesign && entry.Rationale != UnsupportedRationale.None)
            {
                errors.Add($"{kind}: rationale '{entry.Rationale}' is only valid for unsupported-by-design.");
            }

            bool needsIssue = entry.Status == ConstructStatus.Gap || entry.Rationale == UnsupportedRationale.Deferred;
            if (needsIssue && !IsIssueLink(entry.Issue))
            {
                errors.Add($"{kind}: status/rationale requires a github.com/DavidObando/gsharp issue link.");
            }

            if (!string.IsNullOrEmpty(entry.Fixture)
                && !File.Exists(Path.Combine(repoRoot, entry.Fixture.Replace('/', Path.DirectorySeparatorChar))))
            {
                errors.Add($"{kind}: fixture '{entry.Fixture}' does not exist.");
            }
        }

        foreach (string kind in surface.Where(k => !kinds.Contains(k)).OrderBy(k => k, StringComparer.Ordinal))
        {
            errors.Add($"{kind}: on the Roslyn surface but missing from the inventory (run `cs2gs coverage --write`).");
        }

        return errors;
    }

    /// <summary>
    /// Builds the human-readable coverage matrix generated into
    /// <c>docs/cs2gs-coverage-matrix.md</c>.
    /// </summary>
    /// <returns>The markdown text, LF line endings.</returns>
    public string BuildMatrixMarkdown()
    {
        var sb = new StringBuilder();
        List<ConstructEntry> sorted = this.Entries.OrderBy(e => e.Kind, StringComparer.Ordinal).ToList();
        ILookup<ConstructStatus, ConstructEntry> byStatus = sorted.ToLookup(e => e.Status);

        sb.AppendLine("# cs2gs C# construct coverage matrix");
        sb.AppendLine();
        sb.AppendLine("Generated from `" + RepoRelativePath + "` by `cs2gs coverage --write`.");
        sb.AppendLine("Drift fails `ConstructInventoryGoldenTests`. Do not edit by hand.");
        sb.AppendLine();
        sb.AppendLine("| Status | Count |");
        sb.AppendLine("| --- | --- |");
        foreach (ConstructStatus status in Enum.GetValues<ConstructStatus>())
        {
            sb.AppendLine($"| {status} | {byStatus[status].Count()} |");
        }

        foreach (ConstructStatus status in Enum.GetValues<ConstructStatus>())
        {
            List<ConstructEntry> entries = byStatus[status].ToList();
            if (entries.Count == 0)
            {
                continue;
            }

            sb.AppendLine();
            sb.AppendLine($"## {status} ({entries.Count})");
            sb.AppendLine();
            sb.AppendLine("| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |");
            sb.AppendLine("| --- | --- | --- | --- | --- | --- | --- |");
            foreach (ConstructEntry entry in entries)
            {
                string rationale = entry.Rationale == UnsupportedRationale.None ? string.Empty : entry.Rationale.ToString();
                sb.AppendLine(
                    $"| {entry.Kind} | {entry.NodeType} | {entry.Rule} | {rationale} " +
                    $"| {entry.Fixture} | {entry.Issue} | {entry.Notes} |");
            }
        }

        return sb.ToString().Replace("\r\n", "\n");
    }

    /// <summary>
    /// Determines whether a string is a link into this repo's issue tracker.
    /// </summary>
    /// <param name="value">The candidate link.</param>
    /// <returns><see langword="true"/> when it is an issue link.</returns>
    private static bool IsIssueLink(string value)
    {
        return !string.IsNullOrEmpty(value)
            && value.StartsWith("https://github.com/DavidObando/gsharp/issues/", StringComparison.Ordinal);
    }
}
