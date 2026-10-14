// <copyright file="ConstructInventory.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Coverage

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.Json
import System.Text.Json.Serialization

/// The translation disposition of one C# construct (one Roslyn node
/// `SyntaxKind`) in the construct inventory.
enum ConstructStatus {
    Unclassified,
    Translated,
    Lowered,
    UnsupportedByDesign,
    Gap
}

/// Why a construct is (cref:ConstructStatus.UnsupportedByDesign). The
/// taxonomy is the arbitration record for contested classifications
/// (ADR-0138).
enum UnsupportedRationale {
    None,
    NoGsharpConstruct,
    Preprocessor,
    ToolingScope,
    SemanticsErased,
    Deferred,
    NotReachable
}

/// The checked-in classification of every C# node kind
/// (`tools/cs2gs/coverage/csharp-construct-inventory.json`): load,
/// validation, and the generated human-readable matrix
/// (`docs/cs2gs-coverage-matrix.md`). ConstructInventoryGoldenTests keeps
/// the inventory, the Roslyn surface, and the generated doc in lockstep.
class ConstructInventory {
    /// Initializes a new instance of the (cref:ConstructInventory) class.
    /// @param entries The inventory rows.
    init(entries IReadOnlyList[ConstructEntry]?) {
        this.Entries = entries ?? throw ArgumentNullException("entries")
    }

    /// Gets the inventory rows.
    prop Entries IReadOnlyList[ConstructEntry] {
        get;
    }

    /// Serializes the inventory (sorted by kind) back to JSON text.
    /// @returns The JSON text, LF line endings, trailing newline.
    func ToJson() string {
        let sorted = this.Entries.OrderBy((e ConstructEntry) -> e.Kind, StringComparer.Ordinal).ToList()
        return JsonSerializer.Serialize(sorted, SerializerOptions).Replace("\r\n", "\n") + "\n"
    }

    /// Validates the inventory against the live Roslyn surface and the schema
    /// invariants. Fixture existence is validated relative to
    /// [`repoRoot`](paramref) when a fixture path is present.
    /// @param repoRoot The repository root directory.
    /// @returns The list of violations; empty when valid.
    func Validate(repoRoot string) IReadOnlyList[string] {
        let errors = List[string]()
        let kinds = HashSet[string](StringComparer.Ordinal)
        let surface = HashSet[string](RoslynSurface.NodeKindNames(), StringComparer.Ordinal)
        for entry in this.Entries {
            let kind = entry.Kind ?? "<null>"
            if !kinds.Add(kind) {
                errors.Add("$kind: duplicate inventory row.")
            }
            if !surface.Contains(kind) {
                errors.Add("$kind: not a node kind on the current Roslyn surface (stale row?).")
            }
            if string.IsNullOrEmpty(entry.NodeType) {
                errors.Add("$kind: nodeType is required.")
            }
            let needsRule = (entry.Status is ConstructStatus.Translated or ConstructStatus.Lowered)
            if needsRule && string.IsNullOrEmpty(entry.Rule) {
                errors.Add("$kind: status '${entry.Status}' requires a canonical-rule reference.")
            }
            if entry.Status == ConstructStatus.UnsupportedByDesign && entry.Rationale == UnsupportedRationale.None {
                errors.Add("$kind: unsupported-by-design requires a rationale.")
            }
            if entry.Status != ConstructStatus.UnsupportedByDesign && entry.Rationale != UnsupportedRationale.None {
                errors.Add("$kind: rationale '${entry.Rationale}' is only valid for unsupported-by-design.")
            }
            let needsIssue = entry.Status == ConstructStatus.Gap || entry.Rationale == UnsupportedRationale.Deferred
            if needsIssue && !IsIssueLink(entry.Issue) {
                errors.Add("$kind: status/rationale requires a github.com/DavidObando/gsharp issue link.")
            }
            if !string.IsNullOrEmpty(entry.Fixture) && !File.Exists(
                Path.Combine(repoRoot, entry.Fixture.Replace('/', Path.DirectorySeparatorChar))
            ) {
                errors.Add("$kind: fixture '${entry.Fixture}' does not exist.")
            }
        }
        for kind in surface.Where((k string) -> !kinds.Contains(k)).OrderBy((k string) -> k, StringComparer.Ordinal) {
            errors.Add("$kind: on the Roslyn surface but missing from the inventory (run `cs2gs coverage --write`).")
        }
        return errors
    }

    /// Builds the human-readable coverage matrix generated into
    /// `docs/cs2gs-coverage-matrix.md`.
    /// @returns The markdown text, LF line endings.
    func BuildMatrixMarkdown() string {
        let sb = StringBuilder()
        let sorted = this.Entries.OrderBy((e ConstructEntry) -> e.Kind, StringComparer.Ordinal).ToList()
        let byStatus = sorted.ToLookup((e ConstructEntry) -> e.Status)
        sb.AppendLine("# cs2gs C# construct coverage matrix")
        sb.AppendLine()
        sb.AppendLine("Generated from `" + RepoRelativePath + "` by `cs2gs coverage --write`.")
        sb.AppendLine("Drift fails `ConstructInventoryGoldenTests`. Do not edit by hand.")
        sb.AppendLine()
        sb.AppendLine("| Status | Count |")
        sb.AppendLine("| --- | --- |")
        for status in Enum.GetValues[ConstructStatus]() {
            sb.AppendLine("| $status | ${byStatus[status].Count()} |")
        }
        for status in Enum.GetValues[ConstructStatus]() {
            let entries = byStatus[status].ToList()
            if entries.Count == 0 {
                continue
            }
            sb.AppendLine()
            sb.AppendLine("## $status (${entries.Count})")
            sb.AppendLine()
            sb.AppendLine("| Kind | Node type | Rule | Rationale | Fixture | Issue | Notes |")
            sb.AppendLine("| --- | --- | --- | --- | --- | --- | --- |")
            for entry in entries {
                let rationale = if entry.Rationale == UnsupportedRationale.None {
                    string.Empty
                } else {
                    entry.Rationale.ToString()
                }
                sb.AppendLine(
                    "| ${entry.Kind} | ${entry.NodeType} | ${entry.Rule} | $rationale " +
                        "| ${entry.Fixture} | ${entry.Issue} | ${entry.Notes} |"
                )
            }
        }
        return sb.ToString().Replace("\r\n", "\n")
    }

    shared {
        /// The repo-relative path of the inventory data file.
        const RepoRelativePath string = "tools/cs2gs/coverage/csharp-construct-inventory.json"

        /// The repo-relative path of the generated matrix document.
        const MatrixRepoRelativePath string = "docs/cs2gs-coverage-matrix.md"

        private let SerializerOptions JsonSerializerOptions = JsonSerializerOptions{
            WriteIndented: true,
            DefaultIgnoreCondition: JsonIgnoreCondition.WhenWritingNull
        }

        /// Loads the inventory from a JSON file.
        /// @param path The file path.
        /// @returns The loaded inventory.
        func Load(path string) ConstructInventory {
            using let stream = File.OpenRead(path)
            let entries List[ConstructEntry]? = JsonSerializer.Deserialize[List[ConstructEntry]](
                stream,
                SerializerOptions
            )
            return ConstructInventory(entries)
        }

        /// Determines whether a string is a link into this repo's issue tracker.
        /// @param value The candidate link.
        /// @returns `true` when it is an issue link.
        private func IsIssueLink(value string) bool {
            return !string.IsNullOrEmpty(value) && value.StartsWith(
                "https://github.com/DavidObando/gsharp/issues/",
                StringComparison.Ordinal
            )
        }
    }
}
