// <copyright file="TestParityStage.TestNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Security
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Text.Json.Serialization

/// Issue #4633: the per-test-name half of mirrored test parity.
partial class TestParityStage : IMigrationStage {
    /// Issue #4633: checks a COMPLETED mirrored test run name for name against
    /// the C# original's discovered cases, records the numbers on the context
    /// (they reach the run record PASS or FAIL) and writes the full comparison
    /// to (cref:TestNameParityFileName) in the app's artifact directory.
    ///
    /// Every way the check can be unable to run is a failure, never a pass: a
    /// configured oracle directory with no file for this app, an unreadable
    /// oracle, a missing or unreadable TRX, and a TRX with zero results all
    /// fail the app. Only an UNCONFIGURED oracle directory keeps the old
    /// count-only behaviour, and that is recorded as `count-only`.
    /// @param context The stage context.
    /// @returns `null` when per-name parity holds (or is not configured), else the failure artifact.
    internal func CheckTestNames(context StageExecutionContext) TriageArtifact? {
        let oracleDirectory string? = context.Options.CSharpTestOracleDirectory
        if string.IsNullOrEmpty(oracleDirectory) {
            context.TestNameParity = TestNameParitySummary{Mode: TestNameParitySummary.CountOnlyMode}
            const notConfigured = "per-test-name parity NOT configured (no C# test oracle directory); " +
                "count-only check applied (#4633)."
            this.Note(context, notConfigured)
            return nil
        }
        let summary = TestNameParitySummary{Mode: TestNameParitySummary.PerNameMode}
        context.TestNameParity = summary
        var oracle CSharpTestOracle?
        try {
            oracle = CSharpTestOracle.LoadOrNull(oracleDirectory, context.App.Id)
        } catch (ex Exception) when IsReadFailure(ex) {
            return this.NameParityFailure(context, "TEST-ORACLE-INVALID", ex.Message)
        }
        if oracle == nil {
            let missingOracle = "no C# test oracle for '" +
                context
                .App
                .Id +
                "' in " +
                oracleDirectory +
                " (expected " +
                CSharpTestOracle.FileNameFor(context.App.Id) +
                "). A mirrored test project " +
                "without its C# original's case list cannot be checked name for name, and is never " +
                "passed on the count alone (#4633)."
            return this.NameParityFailure(context, "TEST-ORACLE-MISSING", missingOracle)
        }
        summary.CSharpCases = oracle.Tests!!.Count
        let resultsDirectory = SdkCompileRunner.MirroredTestResultsDirectory(context.ArtifactDir)
        let actual = List[TestCaseOutcome]()
        try {
            // Every TRX the run wrote (one per target framework), each parsed
            // strictly: a nameless result fails closed instead of vanishing.
            let files = if Directory.Exists(resultsDirectory) {
                Directory.GetFiles(resultsDirectory, "*.trx")
            } else {
                Array.Empty[string]()
            }
            if files.Length == 0 {
                throw FileNotFoundException("the run wrote no TRX under " + resultsDirectory)
            }
            for file in files.OrderBy((path string) -> path, StringComparer.Ordinal) {
                actual.AddRange(TrxParser.ParseFile(file, requireNames: true))
            }
        } catch (ex Exception) when IsReadFailure(ex) {
            let unreadable = "the migrated run's TRX could not be read, so its cases cannot be compared " +
                "with the C# original's " +
                oracle.Tests!!
                .Count
                .ToString(CultureInfo.InvariantCulture) + " (#4633): " + ex.Message
            return this.NameParityFailure(context, "TEST-RESULTS-UNREADABLE", unreadable)
        }
        summary.MigratedCases = actual.Count
        if actual.Any((result TestCaseOutcome) -> string.IsNullOrWhiteSpace(result?.Name)) {
            let unnamed = "the migrated run's TRX holds a result without a test name, so its cases cannot be " +
                "compared name for name (#4633)."
            return this.NameParityFailure(context, "TEST-RESULTS-UNREADABLE", unnamed)
        }
        if actual.Count == 0 {
            let none = "the migrated run reported ZERO test results, but the C# original discovers " +
                oracle.Tests!!
                .Count
                .ToString(CultureInfo.InvariantCulture) + " case(s) (#4633)."
            return this.NameParityFailure(context, "TEST-NAME-PARITY", none)
        }
        let result = TestNameParity.Compare(oracle.Tests, actual)
        let verdict = (context.Options.TestNameParityBaseline ?? TestNameParityBaseline.Empty).Evaluate(
            context.App.Id,
            result
        )
        summary.MigratedCases = result.ActualCount
        summary.Matched = result.Matched
        summary.TheoryRows = result.TheoryRows
        summary.Missing = result.Missing.Count
        summary.Extra = result.Extra.Count
        summary.Explained = verdict.Explained.Count
        summary.StaleBaselineEntries.AddRange(
            verdict.StaleEntries.Select((entry TestNameParityBaselineEntry) -> entry.ToString())
        )
        let reportWritten = this.WriteTestNameParity(context, result, verdict)
        let counts = "per-test-name parity: C# discovers ${result.ExpectedCount} case(s), migrated run reported " +
            "${result.ActualCount}; matched ${result.Matched} (+${result.TheoryRows} row(s) of " +
            "non-enumerated theories); missing ${result.Missing.Count}, extra ${result.Extra.Count}, " +
            "explained by the baseline ${verdict.Explained.Count}."
        this.Note(context, counts)
        for stale in verdict.StaleEntries {
            let staleNote = "test-name parity baseline entry is STALE — it no longer matches a " +
                "difference, remove it: " +
                stale.ToString()
            this.Note(context, staleNote)
        }
        if verdict.IsMatch {
            return nil
        }
        let message = StringBuilder()
        message
            .Append("The migrated run does not execute the same test cases as the C# original. ")
            .Append(counts)
            .AppendLine()
        AppendDifferences(message, "missing from the migrated run", verdict.UnexplainedMissing)
        AppendDifferences(message, "not in the C# original", verdict.UnexplainedExtra)
        if reportWritten {
            message.Append("Full lists: ").Append(TestNameParityFileName).Append(". ")
        }
        message
            .Append("A difference that is understood belongs in ")
            .Append(TestNameParityBaseline.DefaultRelativePath)
            .Append(" with a reason and an issue.")
        // A compact, stable key: a hash of the sorted differences (the full
        // lists are in the report file).
        let differences = HashDifferences(verdict)
        return this.NameParityFailure(context, "TEST-NAME-PARITY", message.ToString(), differences)
    }

    private func NameParityFailure(
        context StageExecutionContext,
        id string,
        message string,
        fingerprintKey string? = nil
    ) TriageArtifact {
        this.Note(context, "per-test-name parity FAILED (" + id + "): " + message)
        // Fingerprint on what identifies the failure, never on paths in the
        // message, so the same failure deduplicates across shards and runs.
        return context.Triage.TestParityNameMismatch(
            id,
            message,
            EmittedGsRelative(context),
            fingerprintKey ?? id + "|" + context.App.Id
        )
    }

    private func WriteTestNameParity(
        context StageExecutionContext,
        result TestNameParityResult,
        verdict TestNameParityVerdict
    ) bool {
        let document = TestNameParityReport{
            AppId: context.App.Id,
            CSharpCases: result.ExpectedCount,
            MigratedCases: result.ActualCount,
            Matched: result.Matched,
            TheoryRows: result.TheoryRows,
            Missing: result.Missing.ToList(),
            Extra: result.Extra.ToList(),
            UnexplainedMissing: verdict.UnexplainedMissing.ToList(),
            UnexplainedExtra: verdict.UnexplainedExtra.ToList(),
            Explained: verdict.Explained.ToList(),
            StaleBaselineEntries: verdict
                .StaleEntries
                .Select((entry TestNameParityBaselineEntry) -> entry.ToString())
                .ToList()
        }
        try {
            File.WriteAllText(
                Path.Combine(context.ArtifactDir, TestNameParityFileName),
                JsonSerializer.Serialize(document, JsonSerializerOptions{WriteIndented: true})
            )
            return true
        } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException || ex is SecurityException {
            // Diagnostic detail only; the verdict and its counts are already on
            // the context and in the stage log, which says the report is absent.
            this.Note(context, "could not write " + TestNameParityFileName + ": " + ex.Message)
            return false
        }
    }

    shared {
        /// The per-app file holding the full name comparison, next to the stage log.
        internal const TestNameParityFileName string = "test-name-parity.json"

        /// How many differences of each kind the triage message lists inline.
        private const ListedDifferences int32 = 50

        /// Issue #4633: whether a repository project takes the mirrored test path,
        /// by the one rule both this stage and `cs2gs capture-test-oracle`
        /// use: the evaluated MSBuild `IsTestProject` (from the translate
        /// pass's validation manifest), or the project file itself saying so.
        /// @param evaluatedIsTestProject The evaluated MSBuild classification, when known.
        /// @param projectPath The C# project path.
        /// @returns `true` for a test project.
        func IsMirroredTestProject(evaluatedIsTestProject bool, projectPath string) bool -> evaluatedIsTestProject ||
            IsTestProject(projectPath)

        /// Every way reading (or writing) a parity file can fail that must turn
        /// into a named verdict rather than an unhandled exception: malformed
        /// content, I/O, and access or security refusals.
        private func IsReadFailure(ex Exception) bool -> ex is InvalidOperationException ||
            ex is IOException ||
            ex is UnauthorizedAccessException ||
            ex is SecurityException

        // Streams the sorted differences into SHA-256 one name at a time, so a
        // run that lost thousands of cases does not build one giant string.
        private func HashDifferences(verdict TestNameParityVerdict) string {
            using let hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            hash.AppendData(Encoding.UTF8.GetBytes("missing:\n"))
            for name in verdict.UnexplainedMissing {
                hash.AppendData(Encoding.UTF8.GetBytes(name + "\n"))
            }
            hash.AppendData(Encoding.UTF8.GetBytes("extra:\n"))
            for name in verdict.UnexplainedExtra {
                hash.AppendData(Encoding.UTF8.GetBytes(name + "\n"))
            }
            return Convert.ToHexString(hash.GetHashAndReset())
        }

        private func AppendDifferences(message StringBuilder, label string, names IReadOnlyList[string]) {
            if names.Count == 0 {
                return
            }
            message
                .Append(names.Count.ToString(CultureInfo.InvariantCulture))
                .Append(" case(s) ")
                .Append(label)
                .AppendLine(":")
            for name in names.Take(ListedDifferences) {
                message.Append("  ").AppendLine(name)
            }
            if names.Count > ListedDifferences {
                message
                    .Append("  ... and ")
                    .Append((names.Count - ListedDifferences).ToString(CultureInfo.InvariantCulture))
                    .AppendLine(" more")
            }
        }
    }
}

/// Issue #4633: the shape of `test-name-parity.json`, the full per-app
/// name comparison the stage writes next to its log.
internal class TestNameParityReport {
    /// Gets or sets the corpus app id.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets the number of C# oracle cases.
    @JsonPropertyName("csharpCases")
    @JsonPropertyOrder(int32(1))
    prop CSharpCases int32

    /// Gets or sets the number of migrated results.
    @JsonPropertyName("migratedCases")
    @JsonPropertyOrder(int32(2))
    prop MigratedCases int32

    /// Gets or sets the number of matched C# cases.
    @JsonPropertyName("matched")
    @JsonPropertyOrder(int32(3))
    prop Matched int32

    /// Gets or sets the rows matched to non-enumerated C# theories.
    @JsonPropertyName("theoryRows")
    @JsonPropertyOrder(int32(4))
    prop TheoryRows int32

    /// Gets or sets every C# case the migrated run lacks.
    @JsonPropertyName("missing")
    @JsonPropertyOrder(int32(5))
    prop Missing List[string]

    /// Gets or sets every migrated case the C# oracle lacks.
    @JsonPropertyName("extra")
    @JsonPropertyOrder(int32(6))
    prop Extra List[string]

    /// Gets or sets the missing cases no baseline entry explains.
    @JsonPropertyName("unexplainedMissing")
    @JsonPropertyOrder(int32(7))
    prop UnexplainedMissing List[string]

    /// Gets or sets the extra cases no baseline entry explains.
    @JsonPropertyName("unexplainedExtra")
    @JsonPropertyOrder(int32(8))
    prop UnexplainedExtra List[string]

    /// Gets or sets the differences a baseline entry explained.
    @JsonPropertyName("explained")
    @JsonPropertyOrder(int32(9))
    prop Explained List[string]

    /// Gets or sets the app's baseline entries that explained nothing.
    @JsonPropertyName("staleBaselineEntries")
    @JsonPropertyOrder(int32(10))
    prop StaleBaselineEntries List[string]
}
