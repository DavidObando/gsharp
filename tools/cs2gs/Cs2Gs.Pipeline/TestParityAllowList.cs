// <copyright file="TestParityAllowList.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #3885: the test-parity failure allow-list — the small, explicit set of
/// migrated tests that are KNOWN to fail for a reason that is policy rather than
/// defect, so a mirrored test run whose failures are a subset of it still
/// reports green.
/// <para>
/// The motivating class is a test that asserts on its OWN repository's source
/// layout: <c>test/Sdk.Tests</c> reads <c>Gsharp.NET.Sdk.csproj</c> and matches
/// <c>Contains("SemaphoreSlim updateGate")</c>. The migrated mirror correctly
/// holds <c>.gsproj</c> and G# syntax, so those assertions cannot hold there —
/// and relaxing them would weaken a real guard in the UNMIGRATED repository.
/// Neither "fix the test" nor "fix the translator" applies; the premise "I am
/// running in the C# repo" is deliberately untrue after migration.
/// </para>
/// <para>
/// An allow-list is a hole in the gate by construction, so every rule here
/// exists to keep the hole small, visible and self-maintaining:
/// </para>
/// <list type="number">
/// <item><description>
/// <b>Individual tests only.</b> An entry names one test, and
/// <see cref="ValidateEntries"/> rejects anything that could name more than one:
/// no wildcards, and a name that is at least <c>Class.Method</c>. Matching is
/// suffix-anchored at the METHOD (see <see cref="Matches"/>), so a namespace or
/// class prefix can never match a test — allow-listing a whole app or a whole
/// class is not expressible, not merely discouraged.
/// </description></item>
/// <item><description>
/// <b>Justification is mandatory.</b> An entry without a substantive
/// <c>reason</c> is a load error, not a silently-honoured entry. An unexplained
/// entry is how a list rots.
/// </description></item>
/// <item><description>
/// <b>Report, never hide.</b> <see cref="TestParityAllowListVerdict"/> carries
/// the allowed failures out of the stage so the run record and the gate summary
/// name them even on a PASS.
/// </description></item>
/// <item><description>
/// <b>Stale entries are detectable.</b> An entry whose test did NOT fail in a
/// completed run is reported as stale, mirroring how <c>greenApps</c> reports
/// newly-green apps to bank.
/// </description></item>
/// <item><description>
/// <b>Subset, not intersection.</b> <see cref="Evaluate"/> partitions the
/// failing set; the caller may only pass when
/// <see cref="TestParityAllowListVerdict.UnallowedFailures"/> is empty. "Some
/// failures were allowed" is never enough.
/// </description></item>
/// </list>
/// </summary>
public sealed class TestParityAllowList
{
    /// <summary>
    /// The repository-relative location of the gate's allow-list. It is a file
    /// of its own rather than another key in <c>selfmig-baseline.json</c>: the
    /// baseline is a ratchet (floors and ceilings) edited when a run banks a
    /// win, this is a policy register edited when a test's premise stops
    /// holding, and the two have different authors, different review bars and
    /// different cadences.
    /// </summary>
    public const string DefaultRelativePath = "tools/cs2gs/selfmig-test-allowlist.json";

    /// <summary>
    /// The minimum length of a usable <c>reason</c>. "flaky" and "wip" are not
    /// justifications; the bar is low enough that any real sentence clears it
    /// and high enough that a placeholder does not.
    /// </summary>
    public const int MinimumReasonLength = 24;

    private static readonly Regex FailedTestLine = new Regex(
        @"^[ \t]*Failed[ \t]+(?<name>[^\r\n]*?)(?:[ \t]+\[[^\]\r\n]*\])?[ \t]*$",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    private static readonly Regex ReportedFailureTotal = new Regex(
        @"^[ \t]*(?:Passed|Failed)!\s+-\s+Failed:\s*(?<failed>\d+)",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    private static readonly Regex IssueReference = new Regex(
        @"^#[0-9]+$", RegexOptions.CultureInvariant);

    private readonly List<TestParityAllowListEntry> entries;

    private TestParityAllowList(List<TestParityAllowListEntry> entries)
    {
        this.entries = entries;
    }

    /// <summary>Gets an allow-list with no entries: every failure fails the app.</summary>
    public static TestParityAllowList Empty =>
        new TestParityAllowList(new List<TestParityAllowListEntry>());

    /// <summary>Gets the validated entries, in file order.</summary>
    public IReadOnlyList<TestParityAllowListEntry> Entries => this.entries;

    /// <summary>
    /// Loads and validates the allow-list at <paramref name="path"/>, or returns
    /// <see cref="Empty"/> when no file is there. A file that EXISTS but does
    /// not validate is always an error: a malformed allow-list must stop the run
    /// loudly, never degrade to "allow nothing" (which reads as an unrelated
    /// wall of parity failures) nor to "allow everything".
    /// </summary>
    /// <param name="path">The absolute path to the allow-list JSON, or null.</param>
    /// <returns>The parsed allow-list, or <see cref="Empty"/>.</returns>
    public static TestParityAllowList LoadOrEmpty(string path)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
        {
            return Empty;
        }

        return Load(path);
    }

    /// <summary>
    /// Resolves and loads the allow-list for a repository migration: the
    /// explicitly-supplied path when there is one (and it must then exist), or
    /// <see cref="DefaultRelativePath"/> under the SOURCE repository, which is
    /// optional. The source repository, never the migrated mirror: the list is
    /// a statement the repository being migrated makes about its own tests.
    /// </summary>
    /// <param name="sourceRoot">The source repository root.</param>
    /// <param name="explicitPath">An explicit allow-list path, or null.</param>
    /// <returns>The parsed allow-list, or <see cref="Empty"/>.</returns>
    public static TestParityAllowList LoadForRepository(string sourceRoot, string explicitPath)
    {
        if (!string.IsNullOrEmpty(explicitPath))
        {
            return Load(Path.GetFullPath(explicitPath));
        }

        if (string.IsNullOrEmpty(sourceRoot))
        {
            return Empty;
        }

        return LoadOrEmpty(Path.Combine(
            sourceRoot, DefaultRelativePath.Replace('/', Path.DirectorySeparatorChar)));
    }

    /// <summary>
    /// Loads and validates the allow-list at <paramref name="path"/>, which must exist.
    /// </summary>
    /// <param name="path">The absolute path to the allow-list JSON.</param>
    /// <returns>The parsed allow-list.</returns>
    /// <exception cref="FileNotFoundException">The file does not exist.</exception>
    /// <exception cref="InvalidOperationException">The file is malformed or an entry is invalid.</exception>
    public static TestParityAllowList Load(string path)
    {
        if (path is null)
        {
            throw new ArgumentNullException(nameof(path));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException(
                "Test-parity allow-list not found: " + path, path);
        }

        try
        {
            return Parse(File.ReadAllText(path));
        }
        catch (InvalidOperationException ex)
        {
            throw new InvalidOperationException(path + ": " + ex.Message, ex);
        }
    }

    /// <summary>
    /// Parses and validates allow-list JSON.
    /// </summary>
    /// <param name="json">The allow-list document text.</param>
    /// <returns>The parsed allow-list.</returns>
    /// <exception cref="InvalidOperationException">The JSON is malformed or an entry is invalid.</exception>
    public static TestParityAllowList Parse(string json)
    {
        TestParityAllowListDocument document;
        try
        {
            document = JsonSerializer.Deserialize<TestParityAllowListDocument>(
                json,
                new JsonSerializerOptions { ReadCommentHandling = JsonCommentHandling.Skip });
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                "the test-parity allow-list is not valid JSON: " + ex.Message, ex);
        }

        List<TestParityAllowListEntry> parsed = document is null || document.Entries is null
            ? new List<TestParityAllowListEntry>()
            : document.Entries;

        IReadOnlyList<string> errors = ValidateEntries(parsed);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException(
                "the test-parity allow-list is invalid and the run cannot honour it:" +
                Environment.NewLine + "  - " + string.Join(Environment.NewLine + "  - ", errors));
        }

        return new TestParityAllowList(parsed);
    }

    /// <summary>
    /// The rules an entry has to satisfy, as a list of human-readable errors
    /// (empty when every entry is well-formed). Exposed separately from
    /// <see cref="Parse"/> so each rule is testable on its own.
    /// </summary>
    /// <param name="entries">The entries to check.</param>
    /// <returns>One message per violated rule.</returns>
    public static IReadOnlyList<string> ValidateEntries(
        IReadOnlyList<TestParityAllowListEntry> entries)
    {
        var errors = new List<string>();
        if (entries is null)
        {
            return errors;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < entries.Count; index++)
        {
            TestParityAllowListEntry entry = entries[index];
            string where = "entry " + index.ToString(CultureInfo.InvariantCulture);
            if (entry is null)
            {
                errors.Add(where + ": is null.");
                continue;
            }

            string app = (entry.App ?? string.Empty).Trim();
            string test = (entry.Test ?? string.Empty).Trim();
            string reason = (entry.Reason ?? string.Empty).Trim();
            string issue = (entry.Issue ?? string.Empty).Trim();

            if (app.Length == 0)
            {
                errors.Add(where + ": 'app' is required — an entry is scoped to one app id.");
            }
            else if (app.IndexOf('*') >= 0 || app.IndexOf('?') >= 0)
            {
                errors.Add(where + " ('" + app + "'): 'app' must be a literal app id, not a pattern.");
            }
            else if (!app.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add(where + " ('" + app + "'): 'app' must be the repository-relative " +
                    "'.csproj' path the gate reports (e.g. 'test/Sdk.Tests/Sdk.Tests.csproj'), " +
                    "so an entry cannot silently widen to a directory.");
            }

            if (test.Length == 0)
            {
                errors.Add(where + ": 'test' is required — the allow-list is per TEST, never per app.");
            }
            else if (test.IndexOf('*') >= 0 || test.IndexOf('?') >= 0)
            {
                errors.Add(where + " ('" + test + "'): 'test' must not contain wildcards; " +
                    "one entry allows exactly one test method.");
            }
            else if (test.IndexOf('.') < 0)
            {
                errors.Add(where + " ('" + test + "'): 'test' must be at least " +
                    "'Class.Method' — a bare name is ambiguous across an app.");
            }
            else if (test.EndsWith(".", StringComparison.Ordinal))
            {
                errors.Add(where + " ('" + test + "'): 'test' must end at the test method name.");
            }

            if (reason.Length < MinimumReasonLength)
            {
                errors.Add(where + " ('" + test + "'): 'reason' is required and must actually " +
                    "explain why this failure is policy rather than a defect (at least " +
                    MinimumReasonLength.ToString(CultureInfo.InvariantCulture) +
                    " characters). An unexplained entry is how an allow-list rots.");
            }

            if (issue.Length > 0 && !IssueReference.IsMatch(issue))
            {
                errors.Add(where + " ('" + test + "'): 'issue' must be a '#<number>' " +
                    "reference when present.");
            }

            if (app.Length > 0 && test.Length > 0 && !seen.Add(app + " " + test))
            {
                errors.Add(where + " ('" + test + "'): duplicate entry for app '" + app + "'.");
            }
        }

        return errors;
    }

    /// <summary>
    /// Extracts the per-test failure names a <c>dotnet test</c> console run
    /// reported (the <c>Failed &lt;name&gt; [12 ms]</c> lines). The run SUMMARY
    /// line (<c>Failed!  - Failed: 3, …</c>) never matches: it spells
    /// <c>Failed!</c> with no separating whitespace.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <returns>The reported failing test names, in output order.</returns>
    public static IReadOnlyList<string> ParseFailedTestNames(string output)
    {
        var names = new List<string>();
        if (string.IsNullOrEmpty(output))
        {
            return names;
        }

        foreach (Match match in FailedTestLine.Matches(output))
        {
            string name = match.Groups["name"].Value.Trim();
            if (name.Length > 0)
            {
                names.Add(name);
            }
        }

        return names;
    }

    /// <summary>
    /// The number of failures the run SUMMARY reports, summed across every
    /// summary line. The stage cross-checks this against
    /// <see cref="ParseFailedTestNames"/>: allow-listing on a name list that
    /// does not account for every reported failure would let an unnamed failure
    /// through, so a mismatch must refuse the allow-list rather than trust it.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <returns>The reported failure total, or 0 when there is no summary.</returns>
    public static int ReportedFailureCount(string output)
    {
        if (string.IsNullOrEmpty(output))
        {
            return 0;
        }

        int total = 0;
        foreach (Match match in ReportedFailureTotal.Matches(output))
        {
            total += int.Parse(match.Groups["failed"].Value, CultureInfo.InvariantCulture);
        }

        return total;
    }

    /// <summary>
    /// Normalizes a reported test name for comparison: strips the trailing
    /// theory arguments (<c>Ns.C.M(x: 1)</c> → <c>Ns.C.M</c>) so an entry names
    /// a test METHOD rather than one data row of it.
    /// </summary>
    /// <param name="reported">The name as the test runner reported it.</param>
    /// <returns>The normalized name.</returns>
    public static string NormalizeTestName(string reported)
    {
        string name = (reported ?? string.Empty).Trim();
        int open = name.IndexOf('(');
        return open >= 0 ? name.Substring(0, open).TrimEnd() : name;
    }

    /// <summary>
    /// Partitions an app's reported failures into allowed and not-allowed, and
    /// names the entries for this app that did not fire.
    /// </summary>
    /// <param name="appId">The corpus app id the run belongs to.</param>
    /// <param name="failedTests">The failing test names the run reported.</param>
    /// <returns>The verdict.</returns>
    public TestParityAllowListVerdict Evaluate(string appId, IReadOnlyList<string> failedTests)
    {
        var allowed = new List<string>();
        var unallowed = new List<string>();
        var fired = new HashSet<string>(StringComparer.Ordinal);

        List<TestParityAllowListEntry> scoped = this.entries
            .Where(entry => string.Equals(
                (entry.App ?? string.Empty).Trim(),
                (appId ?? string.Empty).Trim(),
                StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (string reported in failedTests ?? Array.Empty<string>())
        {
            string normalized = NormalizeTestName(reported);
            TestParityAllowListEntry match = scoped
                .FirstOrDefault(entry => Matches(entry, normalized));
            if (match is null)
            {
                unallowed.Add(reported);
            }
            else
            {
                allowed.Add(reported);
                fired.Add(match.Test);
            }
        }

        List<TestParityAllowListEntry> stale = scoped
            .Where(entry => !fired.Contains(entry.Test))
            .ToList();

        return new TestParityAllowListVerdict(allowed, unallowed, stale);
    }

    /// <summary>
    /// Gets the entries scoped to one app id.
    /// </summary>
    /// <param name="appId">The corpus app id.</param>
    /// <returns>The entries for that app.</returns>
    public IReadOnlyList<TestParityAllowListEntry> EntriesFor(string appId) => this.entries
        .Where(entry => string.Equals(
            (entry.App ?? string.Empty).Trim(),
            (appId ?? string.Empty).Trim(),
            StringComparison.OrdinalIgnoreCase))
        .ToList();

    /// <summary>
    /// Whether an entry names the reported test. The comparison is anchored at
    /// the END of the name, so <c>SdkLayoutTests.Foo</c> matches
    /// <c>GSharp.Sdk.Tests.SdkLayoutTests.Foo</c> but <c>GSharp.Sdk.Tests</c> —
    /// or any other namespace/class prefix — matches nothing at all. That
    /// asymmetry is the mechanism by which "allow-list a whole app" is
    /// impossible rather than merely disallowed.
    /// </summary>
    private static bool Matches(TestParityAllowListEntry entry, string normalizedReported)
    {
        string test = (entry.Test ?? string.Empty).Trim();
        if (test.Length == 0)
        {
            return false;
        }

        return string.Equals(normalizedReported, test, StringComparison.Ordinal)
            || normalizedReported.EndsWith("." + test, StringComparison.Ordinal);
    }
}

/// <summary>One allow-listed test-parity failure (issue #3885).</summary>
public sealed class TestParityAllowListEntry
{
    /// <summary>Gets or sets the corpus app id (a repository-relative <c>.csproj</c> path).</summary>
    [JsonPropertyName("app")]
    [JsonPropertyOrder(0)]
    public string App { get; set; }

    /// <summary>
    /// Gets or sets the test this entry allows, as at least
    /// <c>Class.Method</c>. Never a pattern, never a class or namespace.
    /// </summary>
    [JsonPropertyName("test")]
    [JsonPropertyOrder(1)]
    public string Test { get; set; }

    /// <summary>
    /// Gets or sets why this failure is a policy exclusion rather than a
    /// defect. Mandatory: see <see cref="TestParityAllowList.MinimumReasonLength"/>.
    /// </summary>
    [JsonPropertyName("reason")]
    [JsonPropertyOrder(2)]
    public string Reason { get; set; }

    /// <summary>Gets or sets the tracking issue (<c>#3885</c>), when there is one.</summary>
    [JsonPropertyName("issue")]
    [JsonPropertyOrder(3)]
    public string Issue { get; set; }

    /// <summary>Gets a one-line description used in run records and gate output.</summary>
    /// <returns>The description.</returns>
    public override string ToString() =>
        this.Test + " (" + this.App + (string.IsNullOrEmpty(this.Issue) ? ")" : ", " + this.Issue + ")");
}

/// <summary>The document shape of <c>selfmig-test-allowlist.json</c>.</summary>
public sealed class TestParityAllowListDocument
{
    /// <summary>Gets or sets the schema version (always <c>"1.0"</c>).</summary>
    [JsonPropertyName("schemaVersion")]
    [JsonPropertyOrder(0)]
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>Gets or sets the file-level explanation of what the list is for.</summary>
    [JsonPropertyName("comment")]
    [JsonPropertyOrder(1)]
    public string Comment { get; set; }

    /// <summary>Gets or sets the entries.</summary>
    [JsonPropertyName("entries")]
    [JsonPropertyOrder(2)]
    public List<TestParityAllowListEntry> Entries { get; set; } = new List<TestParityAllowListEntry>();
}

/// <summary>
/// The result of checking one app's reported test failures against the
/// allow-list (issue #3885).
/// </summary>
public sealed class TestParityAllowListVerdict
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestParityAllowListVerdict"/> class.
    /// </summary>
    /// <param name="allowedFailures">The reported failures an entry covers.</param>
    /// <param name="unallowedFailures">The reported failures no entry covers.</param>
    /// <param name="staleEntries">The entries for this app whose test did not fail.</param>
    public TestParityAllowListVerdict(
        IReadOnlyList<string> allowedFailures,
        IReadOnlyList<string> unallowedFailures,
        IReadOnlyList<TestParityAllowListEntry> staleEntries)
    {
        this.AllowedFailures = allowedFailures ?? Array.Empty<string>();
        this.UnallowedFailures = unallowedFailures ?? Array.Empty<string>();
        this.StaleEntries = staleEntries ?? Array.Empty<TestParityAllowListEntry>();
    }

    /// <summary>Gets the reported failures an allow-list entry covers.</summary>
    public IReadOnlyList<string> AllowedFailures { get; }

    /// <summary>
    /// Gets the reported failures no entry covers. The app may only pass when
    /// this is empty: the rule is "the failing set is a SUBSET of the allowed
    /// set", never "some failures were allowed".
    /// </summary>
    public IReadOnlyList<string> UnallowedFailures { get; }

    /// <summary>
    /// Gets the entries for this app whose test did not fail in a completed run
    /// — i.e. the test now passes and the entry should be removed. Advisory:
    /// reported loudly, but never the reason an app goes red, because the
    /// alternative punishes the PR that FIXES a test.
    /// </summary>
    public IReadOnlyList<TestParityAllowListEntry> StaleEntries { get; }
}
