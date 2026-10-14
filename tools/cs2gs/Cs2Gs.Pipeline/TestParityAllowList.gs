// <copyright file="TestParityAllowList.cs" company="GSharp">
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

/// Issue #3885: the test-parity failure allow-list — the small, explicit set of
/// migrated tests that are KNOWN to fail for a reason that is policy rather than
/// defect, so a mirrored test run whose failures are a subset of it still
/// reports green.
///
/// The motivating class is a test that asserts on its OWN repository's source
/// layout: `test/Sdk.Tests` reads `Gsharp.NET.Sdk.csproj` and matches
/// `Contains("SemaphoreSlim updateGate")`. The migrated mirror correctly
/// holds `.gsproj` and G# syntax, so those assertions cannot hold there —
/// and relaxing them would weaken a real guard in the UNMIGRATED repository.
/// Neither "fix the test" nor "fix the translator" applies; the premise "I am
/// running in the C# repo" is deliberately untrue after migration.
///
/// An allow-list is a hole in the gate by construction, so every rule here
/// exists to keep the hole small, visible and self-maintaining:
///
/// 1. <b>Individual tests only.</b> An entry names one test, and (cref:ValidateEntries) rejects
/// anything that could name more than one: no wildcards, and a name that is at least `Class.Method`.
/// Matching is suffix-anchored at the METHOD (see (cref:Matches)), so a namespace or class prefix can
/// never match a test — allow-listing a whole app or a whole class is not expressible, not merely
/// discouraged.
/// 2. <b>Justification is mandatory.</b> An entry without a substantive `reason` is a load error, not a
/// silently-honoured entry. An unexplained entry is how a list rots.
/// 3. <b>Report, never hide.</b> (cref:TestParityAllowListVerdict) carries the allowed failures out of
/// the stage so the run record and the gate summary name them even on a PASS.
/// 4. <b>Stale entries are detectable.</b> An entry whose test did NOT fail in a completed run is
/// reported as stale, mirroring how `greenApps` reports newly-green apps to bank.
/// 5. <b>Subset, not intersection.</b> (cref:Evaluate) partitions the failing set; the caller may only
/// pass when (cref:TestParityAllowListVerdict.UnallowedFailures) is empty. "Some failures were allowed"
/// is never enough.
class TestParityAllowList {
    private let entries List[TestParityAllowListEntry]?

    private init(entries List[TestParityAllowListEntry]?) {
        this.entries = entries
    }

    /// Gets the validated entries, in file order.
    prop Entries IReadOnlyList[TestParityAllowListEntry]? -> this.entries

    /// Partitions an app's reported failures into allowed and not-allowed, and
    /// names the entries for this app that did not fire.
    /// @param appId The corpus app id the run belongs to.
    /// @param failedTests The failing test names the run reported.
    /// @returns The verdict.
    func Evaluate(appId string, failedTests IReadOnlyList[string]) TestParityAllowListVerdict {
        let allowed = List[string]()
        let unallowed = List[string]()
        let fired = HashSet[string](StringComparer.Ordinal)
        let scoped_ = this.entries!!.Where(
            (entry TestParityAllowListEntry) -> string.Equals(
                (entry.App ?? string.Empty).Trim(),
                (appId ?? string.Empty).Trim(),
                StringComparison.OrdinalIgnoreCase
            )
        )
            .ToList()
        for reported in failedTests ?? Array.Empty[string]() {
            let normalized = NormalizeTestName(reported)
            let match TestParityAllowListEntry? = scoped_.FirstOrDefault(
                (entry TestParityAllowListEntry) -> Matches(entry, normalized)
            )
            if match == nil {
                unallowed.Add(reported)
            } else {
                allowed.Add(reported)
                fired.Add(match.Test)
            }
        }
        let stale = scoped_.Where((entry TestParityAllowListEntry) -> !fired.Contains(entry.Test)).ToList()
        return TestParityAllowListVerdict(allowed, unallowed, stale)
    }

    /// Gets the entries scoped to one app id.
    /// @param appId The corpus app id.
    /// @returns The entries for that app.
    func EntriesFor(appId string) IReadOnlyList[TestParityAllowListEntry] -> this.entries!!.Where(
        (entry TestParityAllowListEntry) -> string.Equals(
            (entry.App ?? string.Empty).Trim(),
            (appId ?? string.Empty).Trim(),
            StringComparison.OrdinalIgnoreCase
        )
    )
        .ToList()

    shared {
        /// The repository-relative location of the gate's allow-list. It is a file
        /// of its own rather than another key in `selfmig-baseline.json`: the
        /// baseline is a ratchet (floors and ceilings) edited when a run banks a
        /// win, this is a policy register edited when a test's premise stops
        /// holding, and the two have different authors, different review bars and
        /// different cadences.
        const DefaultRelativePath string = "tools/cs2gs/selfmig-test-allowlist.json"

        /// The minimum length of a usable `reason`. "flaky" and "wip" are not
        /// justifications; the bar is low enough that any real sentence clears it
        /// and high enough that a placeholder does not.
        const MinimumReasonLength int32 = 24

        private let FailedTestLine Regex = Regex(
            "^[ \\t]*Failed[ \\t]+(?<name>[^\\r\\n]*?)(?:[ \\t]+\\[[^\\]\\r\\n]*\\])?[ \\t]*$$",
            RegexOptions.Multiline | RegexOptions.CultureInvariant
        )
        private let ReportedFailureTotal Regex = Regex(
            "^[ \\t]*(?:Passed|Failed)!\\s+-\\s+Failed:\\s*(?<failed>\\d+)",
            RegexOptions.Multiline | RegexOptions.CultureInvariant
        )
        private let IssueReference Regex = Regex("^#[0-9]+$$", RegexOptions.CultureInvariant)

        /// Gets an allow-list with no entries: every failure fails the app.
        prop Empty TestParityAllowList -> TestParityAllowList(List[TestParityAllowListEntry]())

        /// Loads and validates the allow-list at [`path`](paramref), or returns
        /// (cref:Empty) when no file is there. A file that EXISTS but does
        /// not validate is always an error: a malformed allow-list must stop the run
        /// loudly, never degrade to "allow nothing" (which reads as an unrelated
        /// wall of parity failures) nor to "allow everything".
        /// @param path The absolute path to the allow-list JSON, or null.
        /// @returns The parsed allow-list, or (cref:Empty).
        func LoadOrEmpty(path string) TestParityAllowList {
            if string.IsNullOrEmpty(path) || !File.Exists(path) {
                return Empty
            }
            return Load(path)
        }

        /// Resolves and loads the allow-list for a repository migration: the
        /// explicitly-supplied path when there is one (and it must then exist), or
        /// (cref:DefaultRelativePath) under the SOURCE repository, which is
        /// optional. The source repository, never the migrated mirror: the list is
        /// a statement the repository being migrated makes about its own tests.
        /// @param sourceRoot The source repository root.
        /// @param explicitPath An explicit allow-list path, or null.
        /// @returns The parsed allow-list, or (cref:Empty).
        func LoadForRepository(sourceRoot string, explicitPath string) TestParityAllowList {
            if !string.IsNullOrEmpty(explicitPath) {
                return Load(Path.GetFullPath(explicitPath))
            }
            if string.IsNullOrEmpty(sourceRoot) {
                return Empty
            }
            return LoadOrEmpty(Path.Combine(sourceRoot, DefaultRelativePath.Replace('/', Path.DirectorySeparatorChar)))
        }

        /// Loads and validates the allow-list at [`path`](paramref), which must exist.
        /// @param path The absolute path to the allow-list JSON.
        /// @returns The parsed allow-list.
        /// @exception FileNotFoundException The file does not exist.
        /// @exception InvalidOperationException The file is malformed or an entry is invalid.
        func Load(path string?) TestParityAllowList {
            if path == nil {
                throw ArgumentNullException("path")
            }
            if !File.Exists(path) {
                throw FileNotFoundException("Test-parity allow-list not found: " + path, path)
            }
            try {
                return Parse(File.ReadAllText(path))
            } catch (ex InvalidOperationException) {
                throw InvalidOperationException(path + ": " + ex.Message, ex)
            }
        }

        /// Parses and validates allow-list JSON.
        /// @param json The allow-list document text.
        /// @returns The parsed allow-list.
        /// @exception InvalidOperationException The JSON is malformed or an entry is invalid.
        func Parse(json string) TestParityAllowList {
            var document TestParityAllowListDocument?
            try {
                document = JsonSerializer.Deserialize[TestParityAllowListDocument](
                    json,
                    JsonSerializerOptions{ReadCommentHandling: JsonCommentHandling.Skip}
                )
            } catch (ex JsonException) {
                throw InvalidOperationException("the test-parity allow-list is not valid JSON: " + ex.Message, ex)
            }
            let parsed List[TestParityAllowListEntry]? = if document == nil || document.Entries == nil {
                List[TestParityAllowListEntry]()
            } else {
                document.Entries
            }
            let errors = ValidateEntries(parsed)
            if errors.Count > 0 {
                throw InvalidOperationException(
                    "the test-parity allow-list is invalid and the run cannot honour it:" +
                        Environment.NewLine +
                        "  - " +
                        string.Join(Environment.NewLine + "  - ", errors)
                )
            }
            return TestParityAllowList(parsed)
        }

        /// The rules an entry has to satisfy, as a list of human-readable errors
        /// (empty when every entry is well-formed). Exposed separately from
        /// (cref:Parse) so each rule is testable on its own.
        /// @param entries The entries to check.
        /// @returns One message per violated rule.
        func ValidateEntries(entries IReadOnlyList[TestParityAllowListEntry]?) IReadOnlyList[string] {
            let errors = List[string]()
            if entries == nil {
                return errors
            }
            let seen = HashSet[string](StringComparer.Ordinal)
            for var index = 0; index < entries.Count; index++ {
                let entry TestParityAllowListEntry? = entries[index]
                let where = "entry " + index.ToString(CultureInfo.InvariantCulture)
                if entry == nil {
                    errors.Add(where + ": is null.")
                    continue
                }
                let app = (entry.App ?? string.Empty).Trim()
                let test = (entry.Test ?? string.Empty).Trim()
                let reason = (entry.Reason ?? string.Empty).Trim()
                let issue = (entry.Issue ?? string.Empty).Trim()
                if app.Length == 0 {
                    errors.Add(where + ": 'app' is required — an entry is scoped to one app id.")
                } else if app.IndexOf('*') >= 0 || app.IndexOf('?') >= 0 {
                    errors.Add(where + " ('" + app + "'): 'app' must be a literal app id, not a pattern.")
                } else if !app.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) {
                    errors.Add(
                        where +
                            " ('" +
                            app +
                            "'): 'app' must be the repository-relative " +
                            "'.csproj' path the gate reports (e.g. 'test/Sdk.Tests/Sdk.Tests.csproj'), " +
                            "so an entry cannot silently widen to a directory."
                    )
                }
                if test.Length == 0 {
                    errors.Add(where + ": 'test' is required — the allow-list is per TEST, never per app.")
                } else if test.IndexOf('*') >= 0 || test.IndexOf('?') >= 0 {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'test' must not contain wildcards; " +
                            "one entry allows exactly one test method."
                    )
                } else if test.IndexOf('.') < 0 {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'test' must be at least " +
                            "'Class.Method' — a bare name is ambiguous across an app."
                    )
                } else if test.EndsWith(".", StringComparison.Ordinal) {
                    errors.Add(where + " ('" + test + "'): 'test' must end at the test method name.")
                }
                if reason.Length < MinimumReasonLength {
                    errors.Add(
                        where +
                            " ('" +
                            test +
                            "'): 'reason' is required and must actually " +
                            "explain why this failure is policy rather than a defect (at least " +
                            MinimumReasonLength.ToString(CultureInfo.InvariantCulture) +
                            " characters). An unexplained entry is how an allow-list rots."
                    )
                }
                if issue.Length > 0 && !IssueReference.IsMatch(issue) {
                    errors.Add(where + " ('" + test + "'): 'issue' must be a '#<number>' " + "reference when present.")
                }
                if app.Length > 0 && test.Length > 0 && !seen.Add(app + "\u0000" + test) {
                    errors.Add(where + " ('" + test + "'): duplicate entry for app '" + app + "'.")
                }
            }
            return errors
        }

        /// Extracts the per-test failure names a `dotnet test` console run
        /// reported (the `Failed <name> [12 ms]` lines). The run SUMMARY
        /// line (`Failed! - Failed: 3, …`) never matches: it spells
        /// `Failed!` with no separating whitespace.
        /// @param output The captured `dotnet test` output.
        /// @returns The reported failing test names, in output order.
        func ParseFailedTestNames(output string) IReadOnlyList[string] {
            let names = List[string]()
            if string.IsNullOrEmpty(output) {
                return names
            }
            for match Match in FailedTestLine.Matches(output) {
                let name = match.Groups["name"].Value.Trim()
                if name.Length > 0 {
                    names.Add(name)
                }
            }
            return names
        }

        /// The number of failures the run SUMMARY reports, summed across every
        /// summary line. The stage cross-checks this against
        /// (cref:ParseFailedTestNames): allow-listing on a name list that
        /// does not account for every reported failure would let an unnamed failure
        /// through, so a mismatch must refuse the allow-list rather than trust it.
        /// @param output The captured `dotnet test` output.
        /// @returns The reported failure total, or 0 when there is no summary.
        func ReportedFailureCount(output string) int32 {
            if string.IsNullOrEmpty(output) {
                return 0
            }
            var total = 0
            for match Match in ReportedFailureTotal.Matches(output) {
                total += int32.Parse(match.Groups["failed"].Value, CultureInfo.InvariantCulture)
            }
            return total
        }

        /// Normalizes a reported test name for comparison: strips the trailing
        /// theory arguments (`Ns.C.M(x: 1)` → `Ns.C.M`) so an entry names
        /// a test METHOD rather than one data row of it.
        /// @param reported The name as the test runner reported it.
        /// @returns The normalized name.
        func NormalizeTestName(reported string) string {
            let name = (reported ?? string.Empty).Trim()
            let open_ = name.IndexOf('(')
            return if open_ >= 0 {
                name.Substring(0, open_).TrimEnd()
            } else {
                name
            }
        }

        /// Whether an entry names the reported test. The comparison is anchored at
        /// the END of the name, so `SdkLayoutTests.Foo` matches
        /// `GSharp.Sdk.Tests.SdkLayoutTests.Foo` but `GSharp.Sdk.Tests` —
        /// or any other namespace/class prefix — matches nothing at all. That
        /// asymmetry is the mechanism by which "allow-list a whole app" is
        /// impossible rather than merely disallowed.
        private func Matches(entry TestParityAllowListEntry, normalizedReported string) bool {
            let test = (entry.Test ?? string.Empty).Trim()
            if test.Length == 0 {
                return false
            }
            return string.Equals(normalizedReported, test, StringComparison.Ordinal) || normalizedReported.EndsWith(
                "." + test,
                StringComparison.Ordinal
            )
        }
    }
}

/// One allow-listed test-parity failure (issue #3885).
class TestParityAllowListEntry {
    /// Gets or sets the corpus app id (a repository-relative `.csproj` path).
    @JsonPropertyName("app")
    @JsonPropertyOrder(int32(0))
    prop App string

    /// Gets or sets the test this entry allows, as at least
    /// `Class.Method`. Never a pattern, never a class or namespace.
    @JsonPropertyName("test")
    @JsonPropertyOrder(int32(1))
    prop Test string

    /// Gets or sets why this failure is a policy exclusion rather than a
    /// defect. Mandatory: see (cref:TestParityAllowList.MinimumReasonLength).
    @JsonPropertyName("reason")
    @JsonPropertyOrder(int32(2))
    prop Reason string

    /// Gets or sets the tracking issue (`#3885`), when there is one.
    @JsonPropertyName("issue")
    @JsonPropertyOrder(int32(3))
    prop Issue string

    /// Gets a one-line description used in run records and gate output.
    /// @returns The description.
    override func ToString() string -> this.Test +
        " (" +
        this.App +
        (
        if string.IsNullOrEmpty(this.Issue) {
            ")"
        } else {
            ", " + this.Issue + ")"
        }
    )
}

/// The document shape of `selfmig-test-allowlist.json`.
class TestParityAllowListDocument {
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

    /// Gets or sets the file-level explanation of what the list is for.
    @JsonPropertyName("comment")
    @JsonPropertyOrder(int32(1))
    prop Comment string

    /// Gets or sets the entries.
    private var _entries List[TestParityAllowListEntry]? = List[TestParityAllowListEntry]()

    @JsonPropertyName("entries")
    @JsonPropertyOrder(int32(2))
    prop Entries List[TestParityAllowListEntry]? {
        get {
            return _entries
        }
        set {
            _entries = value
        }
    }
}

/// The result of checking one app's reported test failures against the
/// allow-list (issue #3885).
class TestParityAllowListVerdict {
    /// Initializes a new instance of the (cref:TestParityAllowListVerdict) class.
    /// @param allowedFailures The reported failures an entry covers.
    /// @param unallowedFailures The reported failures no entry covers.
    /// @param staleEntries The entries for this app whose test did not fail.
    init(
        allowedFailures IReadOnlyList[string],
        unallowedFailures IReadOnlyList[string],
        staleEntries IReadOnlyList[TestParityAllowListEntry]
    ) {
        this.AllowedFailures = allowedFailures ?? Array.Empty[string]()
        this.UnallowedFailures = unallowedFailures ?? Array.Empty[string]()
        this.StaleEntries = staleEntries ?? Array.Empty[TestParityAllowListEntry]()
    }

    /// Gets the reported failures an allow-list entry covers.
    prop AllowedFailures IReadOnlyList[string] {
        get;
    }

    /// Gets the reported failures no entry covers. The app may only pass when
    /// this is empty: the rule is "the failing set is a SUBSET of the allowed
    /// set", never "some failures were allowed".
    prop UnallowedFailures IReadOnlyList[string] {
        get;
    }

    /// Gets the entries for this app whose test did not fail in a completed run
    /// — i.e. the test now passes and the entry should be removed. Advisory:
    /// reported loudly, but never the reason an app goes red, because the
    /// alternative punishes the PR that FIXES a test.
    prop StaleEntries IReadOnlyList[TestParityAllowListEntry] {
        get;
    }
}
