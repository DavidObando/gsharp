// <copyright file="GapLedgerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests.Coverage;

/// <summary>
/// The gap-ledger gate semantics (ADR-0138): NEW / KNOWN / REGRESSED / STALE
/// classification, superseded handling, unverified-app acknowledgement
/// round-trip, and canonical serialization.
/// </summary>
public class GapLedgerTests
{
    [Fact]
    public void Classify_BucketsNewKnownRegressedStale()
    {
        var ledger = new GapLedger(new List<GapLedgerEntry>
        {
            new() { Fingerprint = "sha256:known", Status = GapLedgerEntry.StatusOpen, Issue = 1 },
            new() { Fingerprint = "sha256:fixed", Status = GapLedgerEntry.StatusResolved, Issue = 2 },
            new() { Fingerprint = "sha256:stale", Status = GapLedgerEntry.StatusOpen, Issue = 3 },
            new() { Fingerprint = "sha256:folded", Status = GapLedgerEntry.StatusSuperseded, Issue = 1, SupersededBy = "sha256:known" },
        });

        var artifacts = new List<TriageArtifact>
        {
            Artifact("sha256:known"),
            Artifact("sha256:fixed"),
            Artifact("sha256:folded"),
            Artifact("sha256:brand-new"),
            Artifact("sha256:brand-new"), // duplicate fingerprints collapse
        };

        BaselineClassification classification = ledger.Classify(artifacts, fullCorpus: true);

        Assert.Equal(new[] { "sha256:brand-new" }, classification.New.ConvertAll(a => a.Fingerprint));
        Assert.Equal(new[] { "sha256:fixed" }, classification.Regressed.ConvertAll(a => a.Fingerprint));
        Assert.Equal(2, classification.Known.Count); // known + folded(superseded)
        Assert.Equal(new[] { "sha256:stale" }, classification.Stale.ConvertAll(e => e.Fingerprint));
        Assert.False(classification.PassesGate);
    }

    [Fact]
    public void Classify_PartialRun_SuppressesStale()
    {
        var ledger = new GapLedger(new List<GapLedgerEntry>
        {
            new() { Fingerprint = "sha256:stale", Status = GapLedgerEntry.StatusOpen, Issue = 3 },
        });

        BaselineClassification classification = ledger.Classify(new List<TriageArtifact>(), fullCorpus: false);
        Assert.Empty(classification.Stale);
        Assert.True(classification.PassesGate);
    }

    [Fact]
    public void SaveAndLoad_RoundTripsEnvelope()
    {
        string path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName(), "gaps.json");
        var ledger = new GapLedger(new List<GapLedgerEntry>
        {
            new()
            {
                Fingerprint = "sha256:b",
                Status = GapLedgerEntry.StatusOpen,
                Issue = 42,
                Title = "t",
                Stage = "compile",
                DiagnosticId = "GS0001",
                ConstructKind = "K",
                FirstSeenRun = "r1",
                Apps = new List<string> { "corpus/X" },
            },
            new() { Fingerprint = "sha256:a", Status = GapLedgerEntry.StatusWontfix },
        });
        ledger.UnverifiedApps.Add("corpus/L3-Library");

        ledger.Save(path);
        GapLedger loaded = GapLedger.Load(path);

        Assert.Equal("1.0", loaded.SchemaVersion);
        Assert.Equal(new[] { "corpus/L3-Library" }, loaded.UnverifiedApps);
        Assert.Equal(2, loaded.Entries.Count);
        Assert.Equal("sha256:a", loaded.Entries[0].Fingerprint); // canonical sort
        Assert.Equal(42, loaded.Entries[1].Issue);
        Assert.Equal("corpus/X", Assert.Single(loaded.Entries[1].Apps));

        Directory.Delete(Path.GetDirectoryName(path), recursive: true);
    }

    [Fact]
    public void Load_MissingFile_IsEmptyLedger()
    {
        GapLedger ledger = GapLedger.Load(Path.Combine(Path.GetTempPath(), Path.GetRandomFileName()));
        Assert.Empty(ledger.Entries);
        Assert.Empty(ledger.UnverifiedApps);
    }

    private static TriageArtifact Artifact(string fingerprint) => new()
    {
        Fingerprint = fingerprint,
        Stage = "compile",
        Category = "compile-error",
        RunId = "run",
        CorpusAppId = "corpus/X",
        Diagnostic = new TriageDiagnostic { Id = "GS0001", Message = "m", Severity = "error" },
    };
}
