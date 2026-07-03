// <copyright file="TriageSerializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Text.Json;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests that <see cref="TriageSerialization.Options"/> produces byte-identical
/// output regardless of the host OS's <see cref="System.Environment.NewLine"/>
/// (the determinism contract for <c>summary.json</c>/<c>run.json</c>/triage
/// artifacts, ADR-0115 §F).
/// </summary>
public class TriageSerializationTests
{
    /// <summary>
    /// <c>NewLine</c> is pinned to <c>"\n"</c>: the serialized output never
    /// contains <c>"\r\n"</c>, even though .NET otherwise defaults
    /// <c>JsonSerializerOptions.NewLine</c> to <see cref="System.Environment.NewLine"/>
    /// (which is <c>"\r\n"</c> on Windows).
    /// </summary>
    [Fact]
    public void Options_PinsNewLineToLineFeed()
    {
        Assert.Equal("\n", TriageSerialization.Options.NewLine);

        string json = JsonSerializer.Serialize(SampleArtifact(), TriageSerialization.Options);

        Assert.DoesNotContain("\r\n", json, System.StringComparison.Ordinal);
        Assert.Contains("\n", json, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// Serializing the same model twice yields byte-identical output — the
    /// baseline determinism guarantee that cross-OS diffing, golden files, and
    /// content-hash dedup depend on.
    /// </summary>
    [Fact]
    public void Serialization_IsByteIdentical_AcrossRepeatedRuns()
    {
        TriageArtifact artifact = SampleArtifact();

        string first = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        string second = JsonSerializer.Serialize(SampleArtifact(), TriageSerialization.Options);

        Assert.Equal(first, second);
    }

    /// <summary>
    /// A small fixed model serializes to an exact golden byte string, pinning
    /// indentation, property order, and line endings all at once.
    /// </summary>
    [Fact]
    public void Serialization_MatchesGoldenBytes_ForFixedModel()
    {
        var diagnostic = new TriageDiagnostic
        {
            Id = "GS0313",
            Message = "unsupported construct",
            Severity = "error",
        };

        string json = JsonSerializer.Serialize(diagnostic, TriageSerialization.Options);

        const string expected =
            "{\n" +
            "  \"id\": \"GS0313\",\n" +
            "  \"message\": \"unsupported construct\",\n" +
            "  \"severity\": \"error\"\n" +
            "}";

        Assert.Equal(expected, json);
    }

    private static TriageArtifact SampleArtifact()
    {
        return new TriageArtifact
        {
            RunId = "2026-06-21T20-00-00Z_3f9c1a",
            Timestamp = "2026-06-21T20:00:00Z",
            GscVersion = "1.0.0",
            CorpusAppId = "corpus/L2-Library",
            Stage = "translate",
            Category = "translation-unsupported",
            Diagnostic = new TriageDiagnostic
            {
                Id = "GS0313",
                Message = "unsupported construct",
                Severity = "error",
            },
            SourceLocation = new TriageSourceLocation
            {
                GsFile = "L2-Library.gs",
                GsLine = 10,
                GsColumn = 5,
                CsFile = "L2-Library.cs",
                CsLine = 12,
                CsColumn = 9,
            },
            OffendingCSharpConstruct = new TriageOffendingConstruct
            {
                Kind = "RecordDeclaration",
                Snippet = "record Point(int X, int Y);",
            },
            SuggestedIssue = new TriageSuggestedIssue
            {
                Title = "Support record declarations",
                Body = "cs2gs cannot translate this construct.",
                Labels = { "Oats" },
            },
            Fingerprint = "sha256:deadbeef",
        };
    }
}
