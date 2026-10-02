// <copyright file="TestParityStage.TestNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #4633: the per-test-name half of mirrored test parity.
/// </summary>
public sealed partial class TestParityStage
{
    /// <summary>The per-app file holding the full name comparison, next to the stage log.</summary>
    internal const string TestNameParityFileName = "test-name-parity.json";

    /// <summary>How many differences of each kind the triage message lists inline.</summary>
    private const int ListedDifferences = 50;

    /// <summary>
    /// Issue #4633: whether a repository project takes the mirrored test path,
    /// by the one rule both this stage and <c>cs2gs capture-test-oracle</c>
    /// use: the evaluated MSBuild <c>IsTestProject</c> (from the translate
    /// pass's validation manifest), or the project file itself saying so.
    /// </summary>
    /// <param name="evaluatedIsTestProject">The evaluated MSBuild classification, when known.</param>
    /// <param name="projectPath">The C# project path.</param>
    /// <returns><see langword="true"/> for a test project.</returns>
    public static bool IsMirroredTestProject(bool evaluatedIsTestProject, string projectPath) =>
        evaluatedIsTestProject || IsTestProject(projectPath);

    /// <summary>
    /// Issue #4633: checks a COMPLETED mirrored test run name for name against
    /// the C# original's discovered cases, records the numbers on the context
    /// (they reach the run record PASS or FAIL) and writes the full comparison
    /// to <see cref="TestNameParityFileName"/> in the app's artifact directory.
    /// <para>
    /// Every way the check can be unable to run is a failure, never a pass: a
    /// configured oracle directory with no file for this app, an unreadable
    /// oracle, a missing or unreadable TRX, and a TRX with zero results all
    /// fail the app. Only an UNCONFIGURED oracle directory keeps the old
    /// count-only behaviour, and that is recorded as <c>count-only</c>.
    /// </para>
    /// </summary>
    /// <param name="context">The stage context.</param>
    /// <returns><see langword="null"/> when per-name parity holds (or is not configured), else the failure artifact.</returns>
    internal TriageArtifact CheckTestNames(StageExecutionContext context)
    {
        string oracleDirectory = context.Options.CSharpTestOracleDirectory;
        if (string.IsNullOrEmpty(oracleDirectory))
        {
            context.TestNameParity = new TestNameParitySummary { Mode = TestNameParitySummary.CountOnlyMode };
            const string notConfigured = "per-test-name parity NOT configured (no C# test oracle directory); " +
                "count-only check applied (#4633).";
            this.Note(context, notConfigured);
            return null;
        }

        var summary = new TestNameParitySummary { Mode = TestNameParitySummary.PerNameMode };
        context.TestNameParity = summary;

        CSharpTestOracle oracle;
        try
        {
            oracle = CSharpTestOracle.LoadOrNull(oracleDirectory, context.App.Id);
        }
        catch (Exception ex) when (IsReadFailure(ex))
        {
            return this.NameParityFailure(context, "TEST-ORACLE-INVALID", ex.Message);
        }

        if (oracle is null)
        {
            string missingOracle = "no C# test oracle for '" + context.App.Id + "' in " + oracleDirectory +
                " (expected " + CSharpTestOracle.FileNameFor(context.App.Id) + "). A mirrored test project " +
                "without its C# original's case list cannot be checked name for name, and is never " +
                "passed on the count alone (#4633).";
            return this.NameParityFailure(context, "TEST-ORACLE-MISSING", missingOracle);
        }

        summary.CSharpCases = oracle.Tests.Count;
        string trxPath = SdkCompileRunner.MirroredTestResultsPath(context.ArtifactDir);
        IReadOnlyList<TestCaseOutcome> actual;
        try
        {
            actual = TrxParser.ParseFile(trxPath);
        }
        catch (Exception ex) when (IsReadFailure(ex))
        {
            string unreadable = "the migrated run's TRX could not be read, so its cases cannot be compared " +
                "with the C# original's " + oracle.Tests.Count.ToString(CultureInfo.InvariantCulture) +
                " (#4633): " + ex.Message;
            return this.NameParityFailure(context, "TEST-RESULTS-UNREADABLE", unreadable);
        }

        summary.MigratedCases = actual.Count;
        if (actual.Count == 0)
        {
            string none = "the migrated run reported ZERO test results, but the C# original discovers " +
                oracle.Tests.Count.ToString(CultureInfo.InvariantCulture) + " case(s) (#4633).";
            return this.NameParityFailure(context, "TEST-NAME-PARITY", none);
        }

        TestNameParityResult result = TestNameParity.Compare(oracle.Tests, actual);
        TestNameParityVerdict verdict = (context.Options.TestNameParityBaseline ?? TestNameParityBaseline.Empty)
            .Evaluate(context.App.Id, result);
        summary.Matched = result.Matched;
        summary.TheoryRows = result.TheoryRows;
        summary.Missing = result.Missing.Count;
        summary.Extra = result.Extra.Count;
        summary.Explained = verdict.Explained.Count;
        summary.StaleBaselineEntries.AddRange(verdict.StaleEntries.Select(entry => entry.ToString()));
        bool reportWritten = this.WriteTestNameParity(context, result, verdict);

        string counts =
            $"per-test-name parity: C# discovers {result.ExpectedCount} case(s), migrated run reported " +
            $"{result.ActualCount}; matched {result.Matched} (+{result.TheoryRows} row(s) of " +
            $"non-enumerated theories); missing {result.Missing.Count}, extra {result.Extra.Count}, " +
            $"explained by the baseline {verdict.Explained.Count}.";
        this.Note(context, counts);
        foreach (TestNameParityBaselineEntry stale in verdict.StaleEntries)
        {
            string staleNote = "test-name parity baseline entry is STALE — it no longer matches a " +
                "difference, remove it: " + stale;
            this.Note(context, staleNote);
        }

        if (verdict.IsMatch)
        {
            return null;
        }

        var message = new StringBuilder();
        message.Append("The migrated run does not execute the same test cases as the C# original. ")
            .Append(counts).AppendLine();
        AppendDifferences(message, "missing from the migrated run", verdict.UnexplainedMissing);
        AppendDifferences(message, "not in the C# original", verdict.UnexplainedExtra);
        if (reportWritten)
        {
            message.Append("Full lists: ").Append(TestNameParityFileName).Append(". ");
        }

        message.Append("A difference that is understood belongs in ")
            .Append(TestNameParityBaseline.DefaultRelativePath).Append(" with a reason and an issue.");
        return this.NameParityFailure(context, "TEST-NAME-PARITY", message.ToString());
    }

    /// <summary>
    /// Every way reading (or writing) a parity file can fail that must turn
    /// into a named verdict rather than an unhandled exception: malformed
    /// content, I/O, and access or security refusals.
    /// </summary>
    private static bool IsReadFailure(Exception ex) =>
        ex is InvalidOperationException
        || ex is IOException
        || ex is UnauthorizedAccessException
        || ex is System.Security.SecurityException;

    private static void AppendDifferences(StringBuilder message, string label, IReadOnlyList<string> names)
    {
        if (names.Count == 0)
        {
            return;
        }

        message.Append(names.Count.ToString(CultureInfo.InvariantCulture)).Append(" case(s) ")
            .Append(label).AppendLine(":");
        foreach (string name in names.Take(ListedDifferences))
        {
            message.Append("  ").AppendLine(name);
        }

        if (names.Count > ListedDifferences)
        {
            message.Append("  ... and ")
                .Append((names.Count - ListedDifferences).ToString(CultureInfo.InvariantCulture))
                .AppendLine(" more");
        }
    }

    private TriageArtifact NameParityFailure(StageExecutionContext context, string id, string message)
    {
        this.Note(context, "per-test-name parity FAILED (" + id + "): " + message);
        return context.Triage.TestParityNameMismatch(id, message, EmittedGsRelative(context));
    }

    private bool WriteTestNameParity(
        StageExecutionContext context, TestNameParityResult result, TestNameParityVerdict verdict)
    {
        var document = new TestNameParityReport
        {
            AppId = context.App.Id,
            CSharpCases = result.ExpectedCount,
            MigratedCases = result.ActualCount,
            Matched = result.Matched,
            TheoryRows = result.TheoryRows,
            Missing = result.Missing.ToList(),
            Extra = result.Extra.ToList(),
            UnexplainedMissing = verdict.UnexplainedMissing.ToList(),
            UnexplainedExtra = verdict.UnexplainedExtra.ToList(),
            Explained = verdict.Explained.ToList(),
            StaleBaselineEntries = verdict.StaleEntries.Select(entry => entry.ToString()).ToList(),
        };
        try
        {
            File.WriteAllText(
                Path.Combine(context.ArtifactDir, TestNameParityFileName),
                JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true }));
            return true;
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is System.Security.SecurityException)
        {
            // Diagnostic detail only; the verdict and its counts are already on
            // the context and in the stage log, which says the report is absent.
            this.Note(context, "could not write " + TestNameParityFileName + ": " + ex.Message);
            return false;
        }
    }
}

/// <summary>
/// Issue #4633: the shape of <c>test-name-parity.json</c>, the full per-app
/// name comparison the stage writes next to its log.
/// </summary>
internal sealed class TestNameParityReport
{
    /// <summary>Gets or sets the corpus app id.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets the number of C# oracle cases.</summary>
    [JsonPropertyName("csharpCases")]
    [JsonPropertyOrder(1)]
    public int CSharpCases { get; set; }

    /// <summary>Gets or sets the number of migrated results.</summary>
    [JsonPropertyName("migratedCases")]
    [JsonPropertyOrder(2)]
    public int MigratedCases { get; set; }

    /// <summary>Gets or sets the number of matched C# cases.</summary>
    [JsonPropertyName("matched")]
    [JsonPropertyOrder(3)]
    public int Matched { get; set; }

    /// <summary>Gets or sets the rows matched to non-enumerated C# theories.</summary>
    [JsonPropertyName("theoryRows")]
    [JsonPropertyOrder(4)]
    public int TheoryRows { get; set; }

    /// <summary>Gets or sets every C# case the migrated run lacks.</summary>
    [JsonPropertyName("missing")]
    [JsonPropertyOrder(5)]
    public List<string> Missing { get; set; }

    /// <summary>Gets or sets every migrated case the C# oracle lacks.</summary>
    [JsonPropertyName("extra")]
    [JsonPropertyOrder(6)]
    public List<string> Extra { get; set; }

    /// <summary>Gets or sets the missing cases no baseline entry explains.</summary>
    [JsonPropertyName("unexplainedMissing")]
    [JsonPropertyOrder(7)]
    public List<string> UnexplainedMissing { get; set; }

    /// <summary>Gets or sets the extra cases no baseline entry explains.</summary>
    [JsonPropertyName("unexplainedExtra")]
    [JsonPropertyOrder(8)]
    public List<string> UnexplainedExtra { get; set; }

    /// <summary>Gets or sets the differences a baseline entry explained.</summary>
    [JsonPropertyName("explained")]
    [JsonPropertyOrder(9)]
    public List<string> Explained { get; set; }

    /// <summary>Gets or sets the app's baseline entries that explained nothing.</summary>
    [JsonPropertyName("staleBaselineEntries")]
    [JsonPropertyOrder(10)]
    public List<string> StaleBaselineEntries { get; set; }
}
