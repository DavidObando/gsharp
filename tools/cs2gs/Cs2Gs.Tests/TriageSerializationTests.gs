// <copyright file="TriageSerializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Text.Json
import Xunit

/// Tests that (cref:TriageSerialization.Options) produces byte-identical
/// output regardless of the host OS's (cref:System.Environment.NewLine)
/// (the determinism contract for `summary.json`/`run.json`/triage
/// artifacts, ADR-0115 §F).
open class TriageSerializationTests {
    /// `NewLine` is pinned to `"\n"`: the serialized output never
    /// contains `"\r\n"`, even though .NET otherwise defaults
    /// `JsonSerializerOptions.NewLine` to (cref:System.Environment.NewLine)
    /// (which is `"\r\n"` on Windows).
    @Fact
    func Options_PinsNewLineToLineFeed() {
        Assert.Equal("\n", TriageSerialization.Options.NewLine)
        let json = JsonSerializer.Serialize(SampleArtifact(), TriageSerialization.Options)
        Assert.DoesNotContain("\r\n", json, StringComparison.Ordinal)
        Assert.Contains("\n", json, StringComparison.Ordinal)
    }

    /// Serializing the same model twice yields byte-identical output — the
    /// baseline determinism guarantee that cross-OS diffing, golden files, and
    /// content-hash dedup depend on.
    @Fact
    func Serialization_IsByteIdentical_AcrossRepeatedRuns() {
        let artifact = SampleArtifact()
        let first = JsonSerializer.Serialize(artifact, TriageSerialization.Options)
        let second = JsonSerializer.Serialize(SampleArtifact(), TriageSerialization.Options)
        Assert.Equal(first, second)
    }

    /// A small fixed model serializes to an exact golden byte string, pinning
    /// indentation, property order, and line endings all at once.
    @Fact
    func Serialization_MatchesGoldenBytes_ForFixedModel() {
        let diagnostic = TriageDiagnostic{Id: "GS0313", Message: "unsupported construct", Severity: "error"}
        let json = JsonSerializer.Serialize(diagnostic, TriageSerialization.Options)
        const expected = "{\n" +
            "  \"id\": \"GS0313\",\n" +
            "  \"message\": \"unsupported construct\",\n" +
            "  \"severity\": \"error\"\n" +
            "}"
        Assert.Equal(expected, json)
    }

    shared {
        private func SampleArtifact() TriageArtifact {
            return TriageArtifact{
                RunId: "2026-06-21T20-00-00Z_3f9c1a",
                Timestamp: "2026-06-21T20:00:00Z",
                GscVersion: "1.0.0",
                CorpusAppId: "corpus/L2-Library",
                Stage: "translate",
                Category: "translation-unsupported",
                Diagnostic: TriageDiagnostic{Id: "GS0313", Message: "unsupported construct", Severity: "error"},
                SourceLocation: TriageSourceLocation{
                    GsFile: "L2-Library.gs",
                    GsLine: 10,
                    GsColumn: 5,
                    CsFile: "L2-Library.cs",
                    CsLine: 12,
                    CsColumn: 9
                },
                OffendingCSharpConstruct: TriageOffendingConstruct{
                    Kind: "RecordDeclaration",
                    Snippet: "record Point(int X, int Y);"
                },
                SuggestedIssue: TriageSuggestedIssue{
                    Title: "Support record declarations",
                    Body: "cs2gs cannot translate this construct.",
                    Labels: {"Oats"}
                },
                Fingerprint: "sha256:deadbeef"
            }
        }
    }
}
