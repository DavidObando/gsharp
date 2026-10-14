// <copyright file="TestNameParityBaseline.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Text.Json
import System.Text.Json.Serialization
import System.Text.RegularExpressions

/// Issue #4633: the register of KNOWN per-test-name differences between a C#
/// test project and its migrated run, each justified on its own line, so the
/// strict per-name check can land green while the differences it found are
/// tracked rather than hidden.
///
/// Four kinds of entry exist, and each excuses as little as possible:
///
/// - `missing`: one exact C# display name the migrated run may lack, once (or `count` times, for a name
/// that legitimately occurs more than once).
/// - `extra`: one exact migrated display name the C# oracle may lack, once (or `count` times).
/// - `rows`: one theory METHOD (`Ns.Class.Method`, no argument list) whose rows render differently on
/// the two sides. It excuses that method's missing and extra rows ONLY when they pair up one for one by
/// argument structure (the same multiset of argument-name lists, e.g. `(x: …, y: …)`), so it covers a
/// value rendering differently between C# and G# and never a lost row hidden behind an unrelated added
/// one.
/// - `renamed-argument`: one theory METHOD whose parameter `argument` is named `renamedTo` in the
/// migrated build. It pairs a missing row with an extra row only when renaming that one argument label
/// turns the first into exactly the second, so every value and every other label must still match.
///
/// Every entry needs a substantive `reason` and an `issue`. Entries
/// that stop matching are reported as stale (advisory, like
/// (cref:TestParityAllowList)), so the register shrinks as fixes land.
/// It is a separate file from the failure allow-list because it answers a
/// different question ("which cases exist" rather than "which cases may fail").
class TestNameParityBaseline {
    private let entries List[TestNameParityBaselineEntry]?

    private init(entries List[TestNameParityBaselineEntry]?) {
        this.entries = entries
    }

    /// Gets the validated entries, in file order.
    prop Entries IReadOnlyList[TestNameParityBaselineEntry]? -> this.entries

    /// Splits one app's name differences into the ones an entry explains and
    /// the ones it does not, and names the entries that explained nothing.
    /// @param appId The corpus app id.
    /// @param result The app's name comparison.
    /// @returns The verdict.
    func Evaluate(appId string, result TestNameParityResult?) TestNameParityVerdict {
        if result == nil {
            throw ArgumentNullException("result")
        }
        let scoped_ = this.entries!!.Where(
            (entry TestNameParityBaselineEntry) -> string.Equals(
                NormalizeAppId(entry.App),
                NormalizeAppId(appId),
                StringComparison.OrdinalIgnoreCase
            )
        )
            .ToList()
        let fired = HashSet[TestNameParityBaselineEntry]()
        // An exact entry excuses ONE occurrence of its name (or `count`): name
        // parity is a multiset, so a second identical missing row is a second
        // difference, not the same one.
        let remaining = scoped_.Where(
            (entry TestNameParityBaselineEntry) -> entry.Kind.Trim() == MissingKind || entry.Kind.Trim() == ExtraKind
        )
            .ToDictionary(
            func (entry TestNameParityBaselineEntry) TestNameParityBaselineEntry {
                return entry
            },
            (entry TestNameParityBaselineEntry) -> entry.Count ?? 1
        )
        // `renamed-argument`: pair each missing row with the extra row it
        // becomes when one argument label is renamed. Paired rows leave the
        // pools; everything else is judged by the other kinds below.
        let explained = List[string]()
        let missingPool = result.Missing.ToList()
        let extraPool = result.Extra.ToList()
        for entry in scoped_.Where((e TestNameParityBaselineEntry) -> e.Kind.Trim() == RenamedArgumentKind) {
            let method = entry.Test.Trim()
            let label = Regex("(?<=\\(|, )" + Regex.Escape(entry.Argument) + ": ", RegexOptions.CultureInvariant)
            for name in missingPool.Where((name string) -> IsRowOf(name, method)).ToList() {
                let renamed = label.Replace(name, entry.RenamedTo + ": ")
                if !string.Equals(renamed, name, StringComparison.Ordinal) && extraPool.Remove(renamed) {
                    missingPool.Remove(name)
                    explained.Add("renamed-argument: " + name)
                    fired.Add(entry)
                }
            }
        }
        // `rows` first: a method whose missing and extra row counts are equal.
        let rowMethods = HashSet[string](StringComparer.Ordinal)
        for entry in scoped_.Where((e TestNameParityBaselineEntry) -> e.Kind.Trim() == RowsKind) {
            let method = entry.Test.Trim()
            let missingShapes = missingPool.Where((name string) -> IsRowOf(name, method)).Select(ArgumentShape).ToList()
            let extraShapes = extraPool.Where((name string) -> IsRowOf(name, method)).Select(ArgumentShape).ToList()
            missingShapes.Sort(StringComparer.Ordinal)
            extraShapes.Sort(StringComparer.Ordinal)
            if missingShapes.Count > 0 && missingShapes.SequenceEqual(extraShapes, StringComparer.Ordinal) {
                rowMethods.Add(method)
                fired.Add(entry)
            }
        }
        for method in rowMethods.OrderBy((name string) -> name, StringComparer.Ordinal) {
            let rows = missingPool.Count((name string) -> IsRowOf(name, method))
            explained.Add(
                "rows: " + method + " (" + rows.ToString(CultureInfo.InvariantCulture) + " row(s) render differently)"
            )
        }
        let unexplainedMissing = List[string]()
        for name in missingPool {
            let match TestNameParityBaselineEntry? = TestNameParityBaseline.Match(
                scoped_,
                remaining,
                MissingKind,
                name,
                rowMethods
            )
            if match == nil {
                unexplainedMissing.Add(name)
                continue
            }
            explained.Add("missing: " + name)
            fired.Add(match)
        }
        let unexplainedExtra = List[string]()
        for name in extraPool {
            let match TestNameParityBaselineEntry? = TestNameParityBaseline.Match(
                scoped_,
                remaining,
                ExtraKind,
                name,
                rowMethods
            )
            if match == nil {
                unexplainedExtra.Add(name)
                continue
            }
            explained.Add("extra: " + name)
            fired.Add(match)
        }
        // Unused, or used fewer times than its `count` claims: either way the
        // entry overstates the difference and should shrink.
        let stale = scoped_.Where(
            (entry TestNameParityBaselineEntry) -> !fired.Contains(entry) ||
                (remaining.TryGetValue(entry, out var left) && left > 0)
        )
            .ToList()
        return TestNameParityVerdict(unexplainedMissing, unexplainedExtra, explained, stale)
    }

    shared {
        /// The repository-relative location of the gate's baseline.
        const DefaultRelativePath string = "tools/cs2gs/selfmig-test-name-baseline.json"

        /// The `missing` entry kind.
        const MissingKind string = "missing"

        /// The `extra` entry kind.
        const ExtraKind string = "extra"

        /// The `rows` entry kind.
        const RowsKind string = "rows"

        /// The `renamed-argument` entry kind.
        const RenamedArgumentKind string = "renamed-argument"

        private let IssueReference Regex = Regex("^#[0-9]+$$", RegexOptions.CultureInvariant)

        // An xUnit argument label: `name: ` at the start of the list or after `, `.
        private let ArgumentNamePattern Regex = Regex("(?:^|, )(\\w+): ", RegexOptions.CultureInvariant)

        /// Gets a baseline with no entries: every difference fails the app.
        prop Empty TestNameParityBaseline -> TestNameParityBaseline(List[TestNameParityBaselineEntry]())

        /// Resolves and loads the baseline for a repository migration: the explicit
        /// path when given (it must exist), otherwise (cref:DefaultRelativePath)
        /// under the source repository when present, otherwise (cref:Empty).
        /// @param sourceRoot The source repository root.
        /// @param explicitPath An explicit baseline path, or null.
        /// @returns The baseline.
        func LoadForRepository(sourceRoot string, explicitPath string) TestNameParityBaseline {
            if !string.IsNullOrEmpty(explicitPath) {
                return Load(Path.GetFullPath(explicitPath))
            }
            if string.IsNullOrEmpty(sourceRoot) {
                return Empty
            }
            let path = Path.Combine(sourceRoot, DefaultRelativePath.Replace('/', Path.DirectorySeparatorChar))
            return if File.Exists(path) {
                Load(path)
            } else {
                Empty
            }
        }

        /// Loads and validates the baseline at [`path`](paramref), which must exist.
        /// @param path The baseline JSON path.
        /// @returns The baseline.
        func Load(path string) TestNameParityBaseline {
            if !File.Exists(path) {
                throw FileNotFoundException("Test-name parity baseline not found: " + path, path)
            }
            try {
                return Parse(File.ReadAllText(path))
            } catch (ex InvalidOperationException) {
                throw InvalidOperationException(path + ": " + ex.Message, ex)
            }
        }

        /// Parses and validates baseline JSON. An invalid entry is a load error,
        /// never a silently ignored or silently honoured one.
        /// @param json The baseline document text.
        /// @returns The baseline.
        func Parse(json string) TestNameParityBaseline {
            var document TestNameParityBaselineDocument?
            try {
                document = JsonSerializer.Deserialize[TestNameParityBaselineDocument](
                    json,
                    JsonSerializerOptions{ReadCommentHandling: JsonCommentHandling.Skip}
                )
            } catch (ex JsonException) {
                throw InvalidOperationException("the test-name parity baseline is not valid JSON: " + ex.Message, ex)
            }
            let parsed List[TestNameParityBaselineEntry]? = if document == nil || document.Entries == nil {
                List[TestNameParityBaselineEntry]()
            } else {
                document.Entries
            }
            let errors = ValidateEntries(parsed)
            if errors.Count > 0 {
                throw InvalidOperationException(
                    "the test-name parity baseline is invalid and the run cannot honour it:" +
                        Environment.NewLine +
                        "  - " +
                        string.Join(Environment.NewLine + "  - ", errors)
                )
            }
            return TestNameParityBaseline(parsed)
        }

        /// The rules every entry must satisfy, as human-readable errors.
        /// @param entries The entries to check.
        /// @returns One message per violated rule (empty when all are valid).
        func ValidateEntries(entries IReadOnlyList[TestNameParityBaselineEntry]?) IReadOnlyList[string] {
            let errors = List[string]()
            let seen = HashSet[string](StringComparer.Ordinal)
            for var index = 0; index < (entries?.Count ?? 0); index++ {
                let entry TestNameParityBaselineEntry? = entries!![index]
                let where = "entry " + index.ToString(CultureInfo.InvariantCulture)
                if entry == nil {
                    errors.Add(where + ": is null.")
                    continue
                }
                let app = (entry.App ?? string.Empty).Trim()
                let kind = (entry.Kind ?? string.Empty).Trim()
                let test = (entry.Test ?? string.Empty).Trim()
                let reason = (entry.Reason ?? string.Empty).Trim()
                let issue = (entry.Issue ?? string.Empty).Trim()
                if !app.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || app.IndexOf('*') >= 0 || app.IndexOf(
                    '?'
                ) >= 0 {
                    errors.Add(
                        where +
                            ": 'app' must be the literal repository-relative '.csproj' " +
                            "path the gate reports (e.g. 'test/Core.Tests/Core.Tests.csproj')."
                    )
                }
                if kind != MissingKind && kind != ExtraKind && kind != RowsKind && kind != RenamedArgumentKind {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'kind' must be '" +
                            MissingKind +
                            "', '" +
                            ExtraKind +
                            "', '" +
                            RowsKind +
                            "' or '" +
                            RenamedArgumentKind +
                            "'."
                    )
                }
                if kind == RenamedArgumentKind &&
                    (
                    !IsIdentifier(entry.Argument) || !IsIdentifier(entry.RenamedTo) || string.Equals(
                        entry.Argument,
                        entry.RenamedTo,
                        StringComparison.Ordinal
                    )
                ) {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): a '" +
                            RenamedArgumentKind +
                            "' entry needs " +
                            "'argument' and 'renamedTo', two different argument names."
                    )
                }
                // Matching is exact, so `*` and `?` are literal characters here (a
                // theory row's string argument may contain either); no entry can
                // name more than the one display name it spells.
                if test.Length == 0 || test.IndexOf('.') < 0 {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'test' must be one fully qualified test " +
                            "display name (matched exactly)."
                    )
                } else if (kind == RowsKind || kind == RenamedArgumentKind) && test.IndexOf('(') >= 0 {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): a 'rows' entry names a theory method " +
                            "('Ns.Class.Method'), without an argument list."
                    )
                }
                if reason.Length < TestParityAllowList.MinimumReasonLength {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'reason' must explain the difference (at least " +
                            TestParityAllowList
                            .MinimumReasonLength
                            .ToString(CultureInfo.InvariantCulture) + " characters)."
                    )
                }
                if !IssueReference.IsMatch(issue) {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'issue' is required and must be a '#<number>' " +
                            "reference to the issue that tracks this difference."
                    )
                }
                if entry.Count is int32 count && (count < 1 || kind == RowsKind || kind == RenamedArgumentKind) {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'count' must be at least 1, and only applies to " +
                            "'missing' and 'extra' entries."
                    )
                }
                // The same name the matcher compares, so two entries that
                // would match the same name are caught as duplicates here.
                if !seen.Add(NormalizeAppId(app).ToUpperInvariant() + "\n" + kind + "\n" + test) {
                    errors.Add(where + " ('" + test + "'): duplicate entry.")
                }
            }
            return errors
        }

        private func Match(
            $scoped List[TestNameParityBaselineEntry],
            remaining Dictionary[TestNameParityBaselineEntry, int32],
            kind string,
            name string,
            rowMethods HashSet[string]
        ) TestNameParityBaselineEntry? {
            let normalized = name
            let exact TestNameParityBaselineEntry? = $scoped.FirstOrDefault(
                (entry TestNameParityBaselineEntry) -> entry.Kind.Trim() == kind && remaining.TryGetValue(
                    entry,
                    out var left
                ) &&
                    left > 0 &&
                    string.Equals(entry.Test.Trim(), normalized, StringComparison.Ordinal)
            )
            if exact != nil {
                remaining[exact] = remaining[exact] - 1
                return exact
            }
            let method string? = TestNameParity.MethodPart(name)
            if !rowMethods.Contains(method!!) || !IsRowOf(name, method) {
                return nil
            }
            return $scoped.FirstOrDefault(
                (entry TestNameParityBaselineEntry) -> entry.Kind.Trim() == RowsKind && string.Equals(
                    entry.Test.Trim(),
                    method,
                    StringComparison.Ordinal
                )
            )
        }

        /// The argument structure of a theory row: its argument names in order
        /// (`Ns.C.M(x: 1, y: "a")` gives `x,y`), ignoring the rendered
        /// values, which are exactly what a `rows` entry allows to differ.
        private func ArgumentShape(row string) string -> string.Join(
            ",",
            ArgumentNamePattern.Matches(row.Substring(row.IndexOf('(') + 1)).Select(
                (match Match) -> match.Groups[1].Value
            )
        )

        // App ids are repository-relative with '/' (as the gate reports them); an
        // entry written with '\' must still match.
        private func NormalizeAppId(appId string) string -> (appId ?? string.Empty).Trim().Replace('\\', '/')

        private func IsIdentifier(value string) bool -> !string.IsNullOrEmpty(value) && value.All(
            (c char) -> char.IsLetterOrDigit(c) || c == '_'
        )

        private func IsRowOf(name string, method string?) bool -> name.Length > method!!.Length && name.StartsWith(
            method!!,
            StringComparison.Ordinal
        ) &&
            name[method!!.Length] == '('
    }
}

/// One justified per-test-name difference (issue #4633).
class TestNameParityBaselineEntry {
    /// Gets or sets the corpus app id (a repository-relative `.csproj` path).
    @JsonPropertyName("app")
    @JsonPropertyOrder(int32(0))
    prop App string

    /// Gets or sets the kind: `missing`, `extra`, `rows` or `renamed-argument`.
    @JsonPropertyName("kind")
    @JsonPropertyOrder(int32(1))
    prop Kind string

    /// Gets or sets the exact display name (or, for `rows`, the theory method).
    @JsonPropertyName("test")
    @JsonPropertyOrder(int32(2))
    prop Test string

    /// Gets or sets why the difference exists.
    @JsonPropertyName("reason")
    @JsonPropertyOrder(int32(3))
    prop Reason string

    /// Gets or sets the tracking issue (`#4633`).
    @JsonPropertyName("issue")
    @JsonPropertyOrder(int32(4))
    prop Issue string?

    /// Gets or sets how many occurrences of the exact name this entry excuses
    /// (`null` means one). Only for `missing`/`extra`.
    @JsonPropertyName("count")
    @JsonPropertyOrder(int32(5))
    prop Count int32?

    /// Gets or sets, for `renamed-argument`, the C# argument name.
    @JsonPropertyName("argument")
    @JsonPropertyOrder(int32(6))
    prop Argument string

    /// Gets or sets, for `renamed-argument`, the migrated argument name.
    @JsonPropertyName("renamedTo")
    @JsonPropertyOrder(int32(7))
    prop RenamedTo string

    /// Gets a one-line description used in run records and logs.
    /// @returns The description.
    override func ToString() string -> this.Kind + " " + this.Test + " (" + this.App + ", " + this.Issue + ")"
}

/// The document shape of `selfmig-test-name-baseline.json`.
class TestNameParityBaselineDocument {
    /// Gets or sets the schema version (always `"1.0"`).
    private var _schemaVersion string = "1.0"

    @JsonPropertyName("schemaVersion")
    @JsonPropertyOrder(int32(0))
    prop SchemaVersion string {
        get {
            return _schemaVersion
        }
        set {
            _schemaVersion = value
        }
    }

    /// Gets or sets the file-level explanation.
    @JsonPropertyName("comment")
    @JsonPropertyOrder(int32(1))
    prop Comment string

    /// Gets or sets the entries.
    private var _entries List[TestNameParityBaselineEntry]? = List[TestNameParityBaselineEntry]()

    @JsonPropertyName("entries")
    @JsonPropertyOrder(int32(2))
    prop Entries List[TestNameParityBaselineEntry]? {
        get {
            return _entries
        }
        set {
            _entries = value
        }
    }
}

/// One app's name differences, split by whether the baseline explains them (issue #4633).
class TestNameParityVerdict {
    /// Initializes a new instance of the (cref:TestNameParityVerdict) class.
    /// @param unexplainedMissing C# names missing from the run that no entry explains.
    /// @param unexplainedExtra Extra migrated names no entry explains.
    /// @param explained The differences an entry explained, prefixed with their kind.
    /// @param staleEntries The app's entries that explained nothing.
    init(
        unexplainedMissing IReadOnlyList[string],
        unexplainedExtra IReadOnlyList[string],
        explained IReadOnlyList[string],
        staleEntries IReadOnlyList[TestNameParityBaselineEntry]
    ) {
        this.UnexplainedMissing = unexplainedMissing ?? Array.Empty[string]()
        this.UnexplainedExtra = unexplainedExtra ?? Array.Empty[string]()
        this.Explained = explained ?? Array.Empty[string]()
        this.StaleEntries = staleEntries ?? Array.Empty[TestNameParityBaselineEntry]()
    }

    /// Gets the C# names the run lacks that no entry explains.
    prop UnexplainedMissing IReadOnlyList[string] {
        get;
    }

    /// Gets the migrated names the oracle lacks that no entry explains.
    prop UnexplainedExtra IReadOnlyList[string] {
        get;
    }

    /// Gets the differences a baseline entry explained.
    prop Explained IReadOnlyList[string] {
        get;
    }

    /// Gets the app's entries that explained nothing (advisory).
    prop StaleEntries IReadOnlyList[TestNameParityBaselineEntry] {
        get;
    }

    /// Gets a value indicating whether the app passes per-name parity.
    prop IsMatch bool -> this.UnexplainedMissing.Count == 0 && this.UnexplainedExtra.Count == 0
}
