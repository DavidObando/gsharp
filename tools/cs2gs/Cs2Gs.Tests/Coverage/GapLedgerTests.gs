// <copyright file="GapLedgerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Coverage

import Cs2Gs.Pipeline
import System.Collections.Generic
import System.IO
import Xunit

/// The gap-ledger gate semantics (ADR-0138): NEW / KNOWN / REGRESSED / STALE
/// classification, superseded handling, unverified-app acknowledgement
/// round-trip, and canonical serialization.
open class GapLedgerTests {
    @Fact
    func Classify_BucketsNewKnownRegressedStale() {
        let ledger = GapLedger(
            List[GapLedgerEntry]{
                GapLedgerEntry{Fingerprint: "sha256:known", Status: GapLedgerEntry.StatusOpen, Issue: 1},
                GapLedgerEntry{Fingerprint: "sha256:fixed", Status: GapLedgerEntry.StatusResolved, Issue: 2},
                GapLedgerEntry{Fingerprint: "sha256:stale", Status: GapLedgerEntry.StatusOpen, Issue: 3},
                GapLedgerEntry{
                    Fingerprint: "sha256:folded",
                    Status: GapLedgerEntry.StatusSuperseded,
                    Issue: 1,
                    SupersededBy: "sha256:known"
                }
            }
        )
        let artifacts = List[TriageArtifact]{
            Artifact("sha256:known"),
            Artifact("sha256:fixed"),
            Artifact("sha256:folded"),
            Artifact("sha256:brand-new"),
            Artifact("sha256:brand-new")
        }
        let classification = ledger.Classify(artifacts, fullCorpus: true)
        Assert.Equal([]string{"sha256:brand-new"}, classification.New.ConvertAll((a TriageArtifact) -> a.Fingerprint))
        Assert.Equal([]string{"sha256:fixed"}, classification.Regressed.ConvertAll((a TriageArtifact) -> a.Fingerprint))
        Assert.Equal(2, classification.Known.Count) // known + folded(superseded)
        Assert.Equal([]string{"sha256:stale"}, classification.Stale.ConvertAll((e GapLedgerEntry) -> e.Fingerprint))
        Assert.False(classification.PassesGate)
    }

    @Fact
    func Classify_PartialRun_SuppressesStale() {
        let ledger = GapLedger(
            List[GapLedgerEntry]{
                GapLedgerEntry{Fingerprint: "sha256:stale", Status: GapLedgerEntry.StatusOpen, Issue: 3}
            }
        )
        let classification = ledger.Classify(List[TriageArtifact](), fullCorpus: false)
        Assert.Empty(classification.Stale)
        Assert.True(classification.PassesGate)
    }

    @Fact
    func SaveAndLoad_RoundTripsEnvelope() {
        let path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName(), "gaps.json")
        let ledger = GapLedger(
            List[GapLedgerEntry]{
                GapLedgerEntry{
                    Fingerprint: "sha256:b",
                    Status: GapLedgerEntry.StatusOpen,
                    Issue: 42,
                    Title: "t",
                    Stage: "compile",
                    DiagnosticId: "GS0001",
                    ConstructKind: "K",
                    FirstSeenRun: "r1",
                    Apps: List[string]{"corpus/X"}
                },
                GapLedgerEntry{Fingerprint: "sha256:a", Status: GapLedgerEntry.StatusWontfix}
            }
        )
        ledger.UnverifiedApps!!.Add("corpus/L3-Library")
        ledger.Save(path)
        let loaded = GapLedger.Load(path)
        Assert.Equal("1.0", loaded.SchemaVersion)
        Assert.Equal([]string{"corpus/L3-Library"}, loaded.UnverifiedApps)
        Assert.Equal(2, loaded.Entries.Count)
        Assert.Equal("sha256:a", loaded.Entries[0].Fingerprint) // canonical sort
        Assert.Equal(42, loaded.Entries[1].Issue)
        Assert.Equal("corpus/X", Assert.Single(loaded.Entries[1].Apps))
        Directory.Delete(Path.GetDirectoryName(path)!!, recursive: true)
    }

    @Fact
    func Load_MissingFile_IsEmptyLedger() {
        let ledger = GapLedger.Load(Path.Combine(Path.GetTempPath(), Path.GetRandomFileName()))
        Assert.Empty(ledger.Entries)
        Assert.Empty(ledger.UnverifiedApps!!)
    }

    shared {
        private func Artifact(fingerprint string) TriageArtifact -> TriageArtifact{
            Fingerprint: fingerprint,
            Stage: "compile",
            Category: "compile-error",
            RunId: "run",
            CorpusAppId: "corpus/X",
            Diagnostic: TriageDiagnostic{Id: "GS0001", Message: "m", Severity: "error"}
        }
    }
}
