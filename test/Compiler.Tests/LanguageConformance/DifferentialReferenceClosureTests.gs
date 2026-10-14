// <copyright file="DifferentialReferenceClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import GSharp.Compiler.Tests
import GSharp.Tests.LanguageConformance
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #3717: differential TPA-versus-reference-closure conformance.
///
/// Every other sample suite compiles with no `/reference:` closure, so
/// gsc resolves imports from the host's trusted platform assemblies and every
/// imported type is a live runtime (cref:Type). The
/// (cref:System.Reflection.MetadataLoadContext) that a real
/// `/reference:` build constructs — every SDK build — is never entered.
/// A whole defect family (#3708/#3715, #3697, #3637, #3636, #3666) is
/// therefore structurally invisible: a host
/// `typeof(X).IsAssignableFrom(clrType)` answers correctly for runtime
/// types and is unconditionally `false` for MLC types, so the
/// wrong arm is silently taken and nothing throws.
///
/// This suite compiles each sample twice — once as today, once against the
/// full `Microsoft.NETCore.App.Ref` closure — and asserts the two agree
/// on diagnostics, on normalised IL and on runtime output. A load-context
/// defect is by definition a disagreement between those two compiles, so the
/// detector needs nobody to anticipate the specific defect: with the #3708 fix
/// reverted this suite fails on the samples that iterate an imported
/// enumerable, naming the method whose `finally` went missing.
///
/// <b>Where it runs.</b> The differential doubles conformance compile time and
/// the ref-pack compile is itself the slower of the two (a ~160-assembly
/// closure through a MetadataLoadContext instead of the host TPA), so the full
/// corpus is <b>nightly</b>, gated on `GSHARP_DIFFERENTIAL_CONFORMANCE=1`.
/// A curated always-on subset — the samples that actually iterate, dispose or
/// reflect over imported types, which is where this family lands — runs on
/// every PR so the mechanism cannot rot between nightlies.
open class DifferentialReferenceClosureTests {
    /// Compiles the sample against both reference closures and fails on any
    /// unlisted divergence.
    /// @param sampleName The sample file name.
    /// @returns A task representing the asynchronous test.
    @Theory
    @MemberData("DifferentialSamples")
    async func Sample_AgreesAcrossReferenceClosures(sampleName string?) {
        if sampleName == nil {
            Assert.True(
                ReferenceClosure.UnavailableReason != nil,
                "the differential was skipped without a recorded reason"
            )
            return
        }
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let sourcePath = Path.Combine(samplesDirectory!!, sampleName)
        let goldenPath = Path.ChangeExtension(sourcePath, ".golden")
        let outcome = await DriverConformanceHarness.RunDifferentialAsync(
            sampleName,
            []string{sourcePath},
            if File.Exists(goldenPath) {
                goldenPath
            } else {
                default(string?)
            }
        )
        AssertBothClosuresWereRealised(outcome)
        AssertRefPackCompileStaysInItsClosure(outcome)
        if KnownDifferences.TryGetValue(sampleName, out var reason) {
            Assert.True(
                outcome.Differences.Count > 0,
                "$sampleName is listed in KnownDifferences ($reason) but the two reference " +
                    "closures now agree. Remove the entry."
            )
            return
        }
        Assert.True(
            outcome.Differences.Count == 0,
            "$sampleName compiles differently against the host TPA and against the " +
                "Microsoft.NETCore.App.Ref closure. This is the load-context defect signature " +
                "(issue #3717): a host `typeof(X).IsAssignableFrom(clrType)` or equivalent is " +
                "taking a different arm for MetadataLoadContext types. Triage it — file an " +
                "issue if it is a defect; only add it to KnownDifferences with a reason if the " +
                `divergence is legitimate.

` +
                string.Join(`

`, outcome.Differences)
        )
    }

    /// Guards the per-PR subset against silent shrinkage, and against listing
    /// a sample that no longer exists.
    @Fact
    func AlwaysOnSubset_IsPresentAndNonVacuous() {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let available = SampleConformanceData.GetSingleFileSamples(samplesDirectory).ToHashSet(StringComparer.Ordinal)
        let missing = AlwaysOnSamples.Where((sample string) -> !available.Contains(sample)).ToArray()
        Assert.True(
            missing.Length == 0,
            "AlwaysOnSamples names samples that no longer exist: " + string.Join(", ", missing)
        )
        // The subset must keep covering the shapes this defect family attacks,
        // or it would run green forever while the nightly does the real work.
        let sources = AlwaysOnSamples.Select(
            (sample string) -> File.ReadAllText(Path.Combine(samplesDirectory!!, sample))
        )
            .ToArray()
        Assert.True(
            sources.Count((text string) -> text.Contains("for ", StringComparison.Ordinal)) >= 4,
            "AlwaysOnSamples must keep at least four `for … in` samples — the #3708 shape."
        )
        Assert.Contains(sources, (text string) -> text.Contains("+=", StringComparison.Ordinal))
        Assert.Contains(sources, (text string) -> text.Contains("Gsharp.Extensions", StringComparison.Ordinal))
    }

    /// Every allow-listed entry must carry a reason and name a sample that
    /// still exists, so neither list can rot into a set of stale keys that
    /// silently stop guarding anything.
    @Fact
    func AllowLists_CarryReasonsAndNameLiveSamples() {
        let samplesDirectory string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDirectory)
        let available = SampleConformanceData.GetSingleFileSamples(samplesDirectory).ToHashSet(StringComparer.Ordinal)
        for entry in KnownDifferences.Concat(KnownRefPackCorlibLeaks) {
            Assert.False(string.IsNullOrWhiteSpace(entry.Value), "${entry.Key} is allow-listed without a reason.")
            Assert.True(available.Contains(entry.Key), "${entry.Key} is allow-listed but is not a sample any more.")
        }
    }

    shared {
        private const FullCorpusEnvironmentVariable string = "GSHARP_DIFFERENTIAL_CONFORMANCE"

        /// The runtime's implementation corlib — only a host-TPA compile should name it.
        private const ImplementationCorlib string = "System.Private.CoreLib"

        /// The targeting pack's corlib contract — a ref-pack compile must name it.
        private const ContractCorlib string = "System.Runtime"

        /// The per-PR subset: samples whose codegen goes through imported types in
        /// the ways this defect family attacks — `for … in` over an imported
        /// enumerable (the #3708 shape), imported delegates and events (#3697),
        /// attribute arguments (#3637), and imported generic instantiations.
        /// The remaining samples run nightly.
        private let AlwaysOnSamples[]string = []string{
            "CountWords.gs",
            "EventSubscription.gs",
            "ForIn.gs",
            "LinqExtensions.gs",
            "MapForIn.gs",
            "Select.gs",
            "TupleSequenceIterators.gs"
        }

        /// Samples whose two compiles legitimately disagree, keyed by file with
        /// the reason — the #3716 guard-rail idiom (a set keyed by file, not an
        /// ordered line-numbered list) so concurrent edits cannot leave a stale
        /// entry that breaks an unrelated PR. The assertion below only ever fails
        /// on an <em>unlisted</em> divergence.
        ///
        /// A difference that is a compiler defect does not belong here: file an
        /// issue and reference it. Entries must name what about the sample makes
        /// the two closures genuinely different, not merely that they are.
        private let KnownDifferences Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal){}

        /// Samples whose ref-pack compile still emits an `AssemblyRef` to
        /// `System.Private.CoreLib`, keyed by file with the reason — the
        /// #3716 guard-rail idiom again. Every entry here is a <b>known defect</b>,
        /// not an accepted behaviour; the list is a burn-down, and the assertion
        /// fails in <em>both</em> directions — an unlisted leak and a listed sample
        /// that has stopped leaking — so fixing a lowering site forces the
        /// corresponding entries out.
        ///
        /// The list is <b>empty</b>: #3718 burned down all 65 original entries at
        /// once, because every leak funnelled through the single
        /// `ImportedMemberRefFactory.GetTypeReference(Type)` row producer,
        /// which now projects a host `typeof` onto the compilation's reference
        /// closure before choosing the TypeRef's resolution scope. It stays here as
        /// a burn-down, not as dead code: a new lowering site that names a
        /// well-known type in a way the projection cannot see re-populates it.
        private let KnownRefPackCorlibLeaks Dictionary[string, string] = Dictionary[string, string](
            StringComparer.Ordinal
        ){}

        func DifferentialSamples() sequence[[]object] {
            let samplesDirectory string? = LocateSamplesDirectory()
            if samplesDirectory == nil {
                yield break
            }
            if !ReferenceClosure.IsRefPackAvailable() {
                // Degrade gracefully rather than emitting an empty theory (which
                // xUnit reports as an error): one row that reports the missing
                // prerequisite by name.
                yield[]object? {nil}
                yield break
            }
            let fullCorpus = string.Equals(
                Environment.GetEnvironmentVariable(FullCorpusEnvironmentVariable),
                "1",
                StringComparison.Ordinal
            )
            for sample in SampleConformanceData.GetSingleFileSamples(samplesDirectory) {
                if !fullCorpus && !AlwaysOnSamples.Contains(sample, StringComparer.Ordinal) {
                    continue
                }
                if OperatingSystem.IsWindows() && sample.StartsWith("PInvoke", StringComparison.Ordinal) {
                    continue
                }
                yield[]object{sample}
            }
        }

        /// The vacuity guard the differential itself needs: a green run proves
        /// nothing if the "ref-pack" compile silently resolved from the host TPA
        /// anyway — the same concern the #3705 load-context differential tests
        /// caught in themselves.
        ///
        /// The evidence is in the emitted `AssemblyRef` table. A compile that
        /// bound against live runtime types names the implementation assembly
        /// `System.Private.CoreLib`; a compile that bound through a
        /// (cref:System.Reflection.MetadataLoadContext) over the targeting
        /// pack names the `System.Runtime` contract. Both must be present, on
        /// their respective sides, or the two modes were not two modes.
        /// @param outcome The differential outcome.
        private func AssertBothClosuresWereRealised(outcome DriverConformanceHarness.DifferentialOutcome) {
            Assert.True(
                outcome.HostTpaAssemblyReferences.Contains(ImplementationCorlib, StringComparer.Ordinal),
                "${outcome.Sample}: the host-TPA compile did not reference $ImplementationCorlib " +
                    "(refs: [${string.Join(", ", outcome.HostTpaAssemblyReferences)}]), so it did " +
                    "not bind against live runtime types and the differential is vacuous."
            )
            Assert.True(
                outcome.RefPackAssemblyReferences.Contains(ContractCorlib, StringComparer.Ordinal),
                "${outcome.Sample}: the ref-pack compile did not reference $ContractCorlib " +
                    "(refs: [${string.Join(", ", outcome.RefPackAssemblyReferences)}]), so it did " +
                    "not bind through the targeting pack and the differential is vacuous."
            )
        }

        /// The ref-pack compile must not reach past its reference closure into the
        /// host runtime. An `AssemblyRef` to `System.Private.CoreLib` in
        /// an assembly compiled entirely against the targeting pack means some
        /// compiler path resolved a well-known type with a host `typeof`
        /// instead of the compilation's load context — the #3717 family's other
        /// face, invisible to the IL comparison because that comparison
        /// deliberately normalises assembly identity away.
        /// @param outcome The differential outcome.
        private func AssertRefPackCompileStaysInItsClosure(outcome DriverConformanceHarness.DifferentialOutcome) {
            if !outcome.RefPackAssemblyReferences.Contains(ImplementationCorlib, StringComparer.Ordinal) {
                Assert.False(
                    KnownRefPackCorlibLeaks.ContainsKey(outcome.Sample),
                    "${outcome.Sample} is listed in KnownRefPackCorlibLeaks but its ref-pack compile " +
                        "no longer references $ImplementationCorlib. Remove the entry."
                )
                return
            }
            Assert.True(
                KnownRefPackCorlibLeaks.ContainsKey(outcome.Sample),
                "${outcome.Sample}: the ref-pack compile emitted an AssemblyRef to " +
                    "$ImplementationCorlib even though it was compiled entirely against the " +
                    "Microsoft.NETCore.App.Ref closure (refs: " +
                    "[${string.Join(", ", outcome.RefPackAssemblyReferences)}]). Some compiler path " +
                    "resolved a well-known type through the host runtime instead of the " +
                    "compilation's MetadataLoadContext. Fix it, or record it here with an issue " +
                    "number."
            )
        }

        private func LocateSamplesDirectory() string? -> SampleConformanceData.LocateSamplesDirectory(
            typeof(DifferentialReferenceClosureTests).Assembly
        )
    }
}
