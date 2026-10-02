// <copyright file="TestNameParityBaseline.cs" company="GSharp">
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
/// Issue #4633: the register of KNOWN per-test-name differences between a C#
/// test project and its migrated run, each justified on its own line, so the
/// strict per-name check can land green while the differences it found are
/// tracked rather than hidden.
/// <para>
/// Three kinds of entry exist, and each excuses as little as possible:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>missing</c>: one exact C# display name the migrated run may lack, once
/// (or <c>count</c> times, for a name that legitimately occurs more than once).
/// </description></item>
/// <item><description>
/// <c>extra</c>: one exact migrated display name the C# oracle may lack, once
/// (or <c>count</c> times).
/// </description></item>
/// <item><description>
/// <c>rows</c>: one theory METHOD (<c>Ns.Class.Method</c>, no argument list)
/// whose rows render differently on the two sides. It excuses that method's
/// missing and extra rows ONLY when they pair up one for one by argument
/// structure (the same multiset of argument-name lists, e.g.
/// <c>(x: …, y: …)</c>), so it covers a value rendering differently between
/// C# and G# and never a lost row hidden behind an unrelated added one.
/// </description></item>
/// <item><description>
/// <c>renamed-argument</c>: one theory METHOD whose parameter <c>argument</c>
/// is named <c>renamedTo</c> in the migrated build. It pairs a missing row
/// with an extra row only when renaming that one argument label turns the
/// first into exactly the second, so every value and every other label must
/// still match.
/// </description></item>
/// </list>
/// <para>
/// Every entry needs a substantive <c>reason</c> and an <c>issue</c>. Entries
/// that stop matching are reported as stale (advisory, like
/// <see cref="TestParityAllowList"/>), so the register shrinks as fixes land.
/// It is a separate file from the failure allow-list because it answers a
/// different question ("which cases exist" rather than "which cases may fail").
/// </para>
/// </summary>
public sealed class TestNameParityBaseline
{
    /// <summary>The repository-relative location of the gate's baseline.</summary>
    public const string DefaultRelativePath = "tools/cs2gs/selfmig-test-name-baseline.json";

    /// <summary>The <c>missing</c> entry kind.</summary>
    public const string MissingKind = "missing";

    /// <summary>The <c>extra</c> entry kind.</summary>
    public const string ExtraKind = "extra";

    /// <summary>The <c>rows</c> entry kind.</summary>
    public const string RowsKind = "rows";

    /// <summary>The <c>renamed-argument</c> entry kind.</summary>
    public const string RenamedArgumentKind = "renamed-argument";

    private static readonly Regex IssueReference = new Regex(
        @"^#[0-9]+$", RegexOptions.CultureInvariant);

    // An xUnit argument label: `name: ` at the start of the list or after `, `.
    private static readonly Regex ArgumentNamePattern = new Regex(
        @"(?:^|, )(\w+): ", RegexOptions.CultureInvariant);

    private readonly List<TestNameParityBaselineEntry> entries;

    private TestNameParityBaseline(List<TestNameParityBaselineEntry> entries)
    {
        this.entries = entries;
    }

    /// <summary>Gets a baseline with no entries: every difference fails the app.</summary>
    public static TestNameParityBaseline Empty =>
        new TestNameParityBaseline(new List<TestNameParityBaselineEntry>());

    /// <summary>Gets the validated entries, in file order.</summary>
    public IReadOnlyList<TestNameParityBaselineEntry> Entries => this.entries;

    /// <summary>
    /// Resolves and loads the baseline for a repository migration: the explicit
    /// path when given (it must exist), otherwise <see cref="DefaultRelativePath"/>
    /// under the source repository when present, otherwise <see cref="Empty"/>.
    /// </summary>
    /// <param name="sourceRoot">The source repository root.</param>
    /// <param name="explicitPath">An explicit baseline path, or null.</param>
    /// <returns>The baseline.</returns>
    public static TestNameParityBaseline LoadForRepository(string sourceRoot, string explicitPath)
    {
        if (!string.IsNullOrEmpty(explicitPath))
        {
            return Load(Path.GetFullPath(explicitPath));
        }

        if (string.IsNullOrEmpty(sourceRoot))
        {
            return Empty;
        }

        string path = Path.Combine(sourceRoot, DefaultRelativePath.Replace('/', Path.DirectorySeparatorChar));
        return File.Exists(path) ? Load(path) : Empty;
    }

    /// <summary>Loads and validates the baseline at <paramref name="path"/>, which must exist.</summary>
    /// <param name="path">The baseline JSON path.</param>
    /// <returns>The baseline.</returns>
    public static TestNameParityBaseline Load(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("Test-name parity baseline not found: " + path, path);
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
    /// Parses and validates baseline JSON. An invalid entry is a load error,
    /// never a silently ignored or silently honoured one.
    /// </summary>
    /// <param name="json">The baseline document text.</param>
    /// <returns>The baseline.</returns>
    public static TestNameParityBaseline Parse(string json)
    {
        TestNameParityBaselineDocument document;
        try
        {
            document = JsonSerializer.Deserialize<TestNameParityBaselineDocument>(
                json,
                new JsonSerializerOptions { ReadCommentHandling = JsonCommentHandling.Skip });
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                "the test-name parity baseline is not valid JSON: " + ex.Message, ex);
        }

        List<TestNameParityBaselineEntry> parsed = document is null || document.Entries is null
            ? new List<TestNameParityBaselineEntry>()
            : document.Entries;
        IReadOnlyList<string> errors = ValidateEntries(parsed);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException(
                "the test-name parity baseline is invalid and the run cannot honour it:" +
                Environment.NewLine + "  - " + string.Join(Environment.NewLine + "  - ", errors));
        }

        return new TestNameParityBaseline(parsed);
    }

    /// <summary>The rules every entry must satisfy, as human-readable errors.</summary>
    /// <param name="entries">The entries to check.</param>
    /// <returns>One message per violated rule (empty when all are valid).</returns>
    public static IReadOnlyList<string> ValidateEntries(IReadOnlyList<TestNameParityBaselineEntry> entries)
    {
        var errors = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < (entries?.Count ?? 0); index++)
        {
            TestNameParityBaselineEntry entry = entries[index];
            string where = "entry " + index.ToString(CultureInfo.InvariantCulture);
            if (entry is null)
            {
                errors.Add(where + ": is null.");
                continue;
            }

            string app = (entry.App ?? string.Empty).Trim();
            string kind = (entry.Kind ?? string.Empty).Trim();
            string test = (entry.Test ?? string.Empty).Trim();
            string reason = (entry.Reason ?? string.Empty).Trim();
            string issue = (entry.Issue ?? string.Empty).Trim();

            if (!app.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) ||
                app.IndexOf('*') >= 0 || app.IndexOf('?') >= 0)
            {
                errors.Add(where + ": 'app' must be the literal repository-relative '.csproj' " +
                    "path the gate reports (e.g. 'test/Core.Tests/Core.Tests.csproj').");
            }

            if (kind != MissingKind && kind != ExtraKind && kind != RowsKind && kind != RenamedArgumentKind)
            {
                errors.Add(where + " ('" + test + "'): 'kind' must be '" + MissingKind + "', '" +
                    ExtraKind + "', '" + RowsKind + "' or '" + RenamedArgumentKind + "'.");
            }

            if (kind == RenamedArgumentKind &&
                (!IsIdentifier(entry.Argument) || !IsIdentifier(entry.RenamedTo) ||
                 string.Equals(entry.Argument, entry.RenamedTo, StringComparison.Ordinal)))
            {
                errors.Add(where + " ('" + test + "'): a '" + RenamedArgumentKind + "' entry needs " +
                    "'argument' and 'renamedTo', two different argument names.");
            }

            // Matching is exact, so `*` and `?` are literal characters here (a
            // theory row's string argument may contain either); no entry can
            // name more than the one display name it spells.
            if (test.Length == 0 || test.IndexOf('.') < 0)
            {
                errors.Add(where + " ('" + test + "'): 'test' must be one fully qualified test " +
                    "display name (matched exactly).");
            }
            else if ((kind == RowsKind || kind == RenamedArgumentKind) && test.IndexOf('(') >= 0)
            {
                errors.Add(where + " ('" + test + "'): a 'rows' entry names a theory method " +
                    "('Ns.Class.Method'), without an argument list.");
            }

            if (reason.Length < TestParityAllowList.MinimumReasonLength)
            {
                errors.Add(where + " ('" + test + "'): 'reason' must explain the difference (at least " +
                    TestParityAllowList.MinimumReasonLength.ToString(CultureInfo.InvariantCulture) +
                    " characters).");
            }

            if (!IssueReference.IsMatch(issue))
            {
                errors.Add(where + " ('" + test + "'): 'issue' is required and must be a '#<number>' " +
                    "reference to the issue that tracks this difference.");
            }

            if (entry.Count is int count && (count < 1 || kind == RowsKind || kind == RenamedArgumentKind))
            {
                errors.Add(where + " ('" + test + "'): 'count' must be at least 1, and only applies to " +
                    "'missing' and 'extra' entries.");
            }

            if (!seen.Add(app + "\n" + kind + "\n" + test))
            {
                errors.Add(where + " ('" + test + "'): duplicate entry.");
            }
        }

        return errors;
    }

    /// <summary>
    /// Splits one app's name differences into the ones an entry explains and
    /// the ones it does not, and names the entries that explained nothing.
    /// </summary>
    /// <param name="appId">The corpus app id.</param>
    /// <param name="result">The app's name comparison.</param>
    /// <returns>The verdict.</returns>
    public TestNameParityVerdict Evaluate(string appId, TestNameParityResult result)
    {
        if (result is null)
        {
            throw new ArgumentNullException(nameof(result));
        }

        List<TestNameParityBaselineEntry> scoped = this.entries
            .Where(entry => string.Equals(
                (entry.App ?? string.Empty).Trim(), (appId ?? string.Empty).Trim(), StringComparison.OrdinalIgnoreCase))
            .ToList();
        var fired = new HashSet<TestNameParityBaselineEntry>();

        // An exact entry excuses ONE occurrence of its name (or `count`): name
        // parity is a multiset, so a second identical missing row is a second
        // difference, not the same one.
        var remaining = scoped
            .Where(entry => entry.Kind.Trim() == MissingKind || entry.Kind.Trim() == ExtraKind)
            .ToDictionary(entry => entry, entry => entry.Count ?? 1);

        // `renamed-argument`: pair each missing row with the extra row it
        // becomes when one argument label is renamed. Paired rows leave the
        // pools; everything else is judged by the other kinds below.
        var explained = new List<string>();
        var missingPool = result.Missing.ToList();
        var extraPool = result.Extra.ToList();
        foreach (TestNameParityBaselineEntry entry in scoped.Where(e => e.Kind.Trim() == RenamedArgumentKind))
        {
            string method = entry.Test.Trim();
            var label = new Regex(@"(?<=\(|, )" + Regex.Escape(entry.Argument) + ": ", RegexOptions.CultureInvariant);
            foreach (string name in missingPool.Where(name => IsRowOf(name, method)).ToList())
            {
                string renamed = label.Replace(name, entry.RenamedTo + ": ");
                if (!string.Equals(renamed, name, StringComparison.Ordinal) && extraPool.Remove(renamed))
                {
                    missingPool.Remove(name);
                    explained.Add("renamed-argument: " + name);
                    fired.Add(entry);
                }
            }
        }

        // `rows` first: a method whose missing and extra row counts are equal.
        var rowMethods = new HashSet<string>(StringComparer.Ordinal);
        foreach (TestNameParityBaselineEntry entry in scoped.Where(e => e.Kind.Trim() == RowsKind))
        {
            string method = entry.Test.Trim();
            List<string> missingShapes = missingPool.Where(name => IsRowOf(name, method)).Select(ArgumentShape).ToList();
            List<string> extraShapes = extraPool.Where(name => IsRowOf(name, method)).Select(ArgumentShape).ToList();
            missingShapes.Sort(StringComparer.Ordinal);
            extraShapes.Sort(StringComparer.Ordinal);
            if (missingShapes.Count > 0 && missingShapes.SequenceEqual(extraShapes, StringComparer.Ordinal))
            {
                rowMethods.Add(method);
                fired.Add(entry);
            }
        }

        foreach (string method in rowMethods.OrderBy(name => name, StringComparer.Ordinal))
        {
            int rows = missingPool.Count(name => IsRowOf(name, method));
            explained.Add("rows: " + method + " (" + rows.ToString(CultureInfo.InvariantCulture) +
                " row(s) render differently)");
        }

        var unexplainedMissing = new List<string>();
        foreach (string name in missingPool)
        {
            TestNameParityBaselineEntry match = Match(scoped, remaining, MissingKind, name, rowMethods);
            if (match is null)
            {
                unexplainedMissing.Add(name);
                continue;
            }

            explained.Add("missing: " + name);
            fired.Add(match);
        }

        var unexplainedExtra = new List<string>();
        foreach (string name in extraPool)
        {
            TestNameParityBaselineEntry match = Match(scoped, remaining, ExtraKind, name, rowMethods);
            if (match is null)
            {
                unexplainedExtra.Add(name);
                continue;
            }

            explained.Add("extra: " + name);
            fired.Add(match);
        }

        // Unused, or used fewer times than its `count` claims: either way the
        // entry overstates the difference and should shrink.
        List<TestNameParityBaselineEntry> stale = scoped
            .Where(entry => !fired.Contains(entry) || (remaining.TryGetValue(entry, out int left) && left > 0))
            .ToList();
        return new TestNameParityVerdict(unexplainedMissing, unexplainedExtra, explained, stale);
    }

    private static TestNameParityBaselineEntry Match(
        List<TestNameParityBaselineEntry> scoped,
        Dictionary<TestNameParityBaselineEntry, int> remaining,
        string kind,
        string name,
        HashSet<string> rowMethods)
    {
        string normalized = TestParityComparison.NormalizeTestName(name);
        TestNameParityBaselineEntry exact = scoped.FirstOrDefault(entry =>
            entry.Kind.Trim() == kind &&
            remaining.TryGetValue(entry, out int left) && left > 0 &&
            string.Equals(TestParityComparison.NormalizeTestName(entry.Test.Trim()), normalized, StringComparison.Ordinal));
        if (exact is not null)
        {
            remaining[exact] = remaining[exact] - 1;
            return exact;
        }

        string method = TestNameParity.MethodPart(name);
        if (!rowMethods.Contains(method) || !IsRowOf(name, method))
        {
            return null;
        }

        return scoped.FirstOrDefault(entry =>
            entry.Kind.Trim() == RowsKind && string.Equals(entry.Test.Trim(), method, StringComparison.Ordinal));
    }

    /// <summary>
    /// The argument structure of a theory row: its argument names in order
    /// (<c>Ns.C.M(x: 1, y: "a")</c> gives <c>x,y</c>), ignoring the rendered
    /// values, which are exactly what a <c>rows</c> entry allows to differ.
    /// </summary>
    private static string ArgumentShape(string row) =>
        string.Join(",", ArgumentNamePattern.Matches(row.Substring(row.IndexOf('(') + 1)).Select(match => match.Groups[1].Value));

    private static bool IsIdentifier(string value) =>
        !string.IsNullOrEmpty(value) && value.All(c => char.IsLetterOrDigit(c) || c == '_');

    private static bool IsRowOf(string name, string method) =>
        name.Length > method.Length &&
        name.StartsWith(method, StringComparison.Ordinal) &&
        name[method.Length] == '(';
}

/// <summary>One justified per-test-name difference (issue #4633).</summary>
public sealed class TestNameParityBaselineEntry
{
    /// <summary>Gets or sets the corpus app id (a repository-relative <c>.csproj</c> path).</summary>
    [JsonPropertyName("app")]
    [JsonPropertyOrder(0)]
    public string App { get; set; }

    /// <summary>Gets or sets the kind: <c>missing</c>, <c>extra</c> or <c>rows</c>.</summary>
    [JsonPropertyName("kind")]
    [JsonPropertyOrder(1)]
    public string Kind { get; set; }

    /// <summary>Gets or sets the exact display name (or, for <c>rows</c>, the theory method).</summary>
    [JsonPropertyName("test")]
    [JsonPropertyOrder(2)]
    public string Test { get; set; }

    /// <summary>Gets or sets why the difference exists.</summary>
    [JsonPropertyName("reason")]
    [JsonPropertyOrder(3)]
    public string Reason { get; set; }

    /// <summary>Gets or sets the tracking issue (<c>#4633</c>).</summary>
    [JsonPropertyName("issue")]
    [JsonPropertyOrder(4)]
    public string Issue { get; set; }

    /// <summary>
    /// Gets or sets how many occurrences of the exact name this entry excuses
    /// (<see langword="null"/> means one). Only for <c>missing</c>/<c>extra</c>.
    /// </summary>
    [JsonPropertyName("count")]
    [JsonPropertyOrder(5)]
    public int? Count { get; set; }

    /// <summary>Gets or sets, for <c>renamed-argument</c>, the C# argument name.</summary>
    [JsonPropertyName("argument")]
    [JsonPropertyOrder(6)]
    public string Argument { get; set; }

    /// <summary>Gets or sets, for <c>renamed-argument</c>, the migrated argument name.</summary>
    [JsonPropertyName("renamedTo")]
    [JsonPropertyOrder(7)]
    public string RenamedTo { get; set; }

    /// <summary>Gets a one-line description used in run records and logs.</summary>
    /// <returns>The description.</returns>
    public override string ToString() =>
        this.Kind + " " + this.Test + " (" + this.App + ", " + this.Issue + ")";
}

/// <summary>The document shape of <c>selfmig-test-name-baseline.json</c>.</summary>
public sealed class TestNameParityBaselineDocument
{
    /// <summary>Gets or sets the schema version (always <c>"1.0"</c>).</summary>
    [JsonPropertyName("schemaVersion")]
    [JsonPropertyOrder(0)]
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>Gets or sets the file-level explanation.</summary>
    [JsonPropertyName("comment")]
    [JsonPropertyOrder(1)]
    public string Comment { get; set; }

    /// <summary>Gets or sets the entries.</summary>
    [JsonPropertyName("entries")]
    [JsonPropertyOrder(2)]
    public List<TestNameParityBaselineEntry> Entries { get; set; } = new List<TestNameParityBaselineEntry>();
}

/// <summary>One app's name differences, split by whether the baseline explains them (issue #4633).</summary>
public sealed class TestNameParityVerdict
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestNameParityVerdict"/> class.
    /// </summary>
    /// <param name="unexplainedMissing">C# names missing from the run that no entry explains.</param>
    /// <param name="unexplainedExtra">Extra migrated names no entry explains.</param>
    /// <param name="explained">The differences an entry explained, prefixed with their kind.</param>
    /// <param name="staleEntries">The app's entries that explained nothing.</param>
    public TestNameParityVerdict(
        IReadOnlyList<string> unexplainedMissing,
        IReadOnlyList<string> unexplainedExtra,
        IReadOnlyList<string> explained,
        IReadOnlyList<TestNameParityBaselineEntry> staleEntries)
    {
        this.UnexplainedMissing = unexplainedMissing ?? Array.Empty<string>();
        this.UnexplainedExtra = unexplainedExtra ?? Array.Empty<string>();
        this.Explained = explained ?? Array.Empty<string>();
        this.StaleEntries = staleEntries ?? Array.Empty<TestNameParityBaselineEntry>();
    }

    /// <summary>Gets the C# names the run lacks that no entry explains.</summary>
    public IReadOnlyList<string> UnexplainedMissing { get; }

    /// <summary>Gets the migrated names the oracle lacks that no entry explains.</summary>
    public IReadOnlyList<string> UnexplainedExtra { get; }

    /// <summary>Gets the differences a baseline entry explained.</summary>
    public IReadOnlyList<string> Explained { get; }

    /// <summary>Gets the app's entries that explained nothing (advisory).</summary>
    public IReadOnlyList<TestNameParityBaselineEntry> StaleEntries { get; }

    /// <summary>Gets a value indicating whether the app passes per-name parity.</summary>
    public bool IsMatch => this.UnexplainedMissing.Count == 0 && this.UnexplainedExtra.Count == 0;
}
