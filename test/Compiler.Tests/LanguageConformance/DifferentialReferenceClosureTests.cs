// <copyright file="DifferentialReferenceClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using GSharp.Tests.LanguageConformance;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

/// <summary>
/// Issue #3717: differential TPA-versus-reference-closure conformance.
///
/// <para>
/// Every other sample suite compiles with no <c>/reference:</c> closure, so
/// gsc resolves imports from the host's trusted platform assemblies and every
/// imported type is a live runtime <see cref="Type"/>. The
/// <see cref="System.Reflection.MetadataLoadContext"/> that a real
/// <c>/reference:</c> build constructs — every SDK build — is never entered.
/// A whole defect family (#3708/#3715, #3697, #3637, #3636, #3666) is
/// therefore structurally invisible: a host
/// <c>typeof(X).IsAssignableFrom(clrType)</c> answers correctly for runtime
/// types and is unconditionally <see langword="false"/> for MLC types, so the
/// wrong arm is silently taken and nothing throws.
/// </para>
///
/// <para>
/// This suite compiles each sample twice — once as today, once against the
/// full <c>Microsoft.NETCore.App.Ref</c> closure — and asserts the two agree
/// on diagnostics, on normalised IL and on runtime output. A load-context
/// defect is by definition a disagreement between those two compiles, so the
/// detector needs nobody to anticipate the specific defect: with the #3708 fix
/// reverted this suite fails on the samples that iterate an imported
/// enumerable, naming the method whose <c>finally</c> went missing.
/// </para>
///
/// <para>
/// <b>Where it runs.</b> The differential doubles conformance compile time and
/// the ref-pack compile is itself the slower of the two (a ~160-assembly
/// closure through a MetadataLoadContext instead of the host TPA), so the full
/// corpus is <b>nightly</b>, gated on <c>GSHARP_DIFFERENTIAL_CONFORMANCE=1</c>.
/// A curated always-on subset — the samples that actually iterate, dispose or
/// reflect over imported types, which is where this family lands — runs on
/// every PR so the mechanism cannot rot between nightlies.
/// </para>
/// </summary>
public class DifferentialReferenceClosureTests
{
    private const string FullCorpusEnvironmentVariable = "GSHARP_DIFFERENTIAL_CONFORMANCE";

    /// <summary>The runtime's implementation corlib — only a host-TPA compile should name it.</summary>
    private const string ImplementationCorlib = "System.Private.CoreLib";

    /// <summary>The targeting pack's corlib contract — a ref-pack compile must name it.</summary>
    private const string ContractCorlib = "System.Runtime";

    /// <summary>
    /// The reason shared by every <see cref="KnownRefPackCorlibLeaks"/> entry:
    /// compiler-synthesised references to well-known BCL types (the
    /// interpolation handler, the async state-machine plumbing, record
    /// <c>ToString</c>/<c>GetHashCode</c> helpers, the variadic
    /// <c>System.Array</c> path, …) are resolved with a host <c>typeof</c>
    /// rather than through the compilation's reference closure, so the emitted
    /// assembly names the implementation corlib.
    /// </summary>
    private const string Issue3718 =
        "#3718 — synthesised well-known-type reference resolved through the host runtime";

    /// <summary>
    /// The per-PR subset: samples whose codegen goes through imported types in
    /// the ways this defect family attacks — <c>for … in</c> over an imported
    /// enumerable (the #3708 shape), imported delegates and events (#3697),
    /// attribute arguments (#3637), and imported generic instantiations.
    /// The remaining samples run nightly.
    /// </summary>
    private static readonly string[] AlwaysOnSamples =
    {
        "CountWords.gs",
        "EventSubscription.gs",
        "ForIn.gs",
        "LinqExtensions.gs",
        "MapForIn.gs",
        "Select.gs",
        "TupleSequenceIterators.gs",
    };

    /// <summary>
    /// Samples whose two compiles legitimately disagree, keyed by file with
    /// the reason — the #3716 guard-rail idiom (a set keyed by file, not an
    /// ordered line-numbered list) so concurrent edits cannot leave a stale
    /// entry that breaks an unrelated PR. The assertion below only ever fails
    /// on an <em>unlisted</em> divergence.
    /// <para>
    /// A difference that is a compiler defect does not belong here: file an
    /// issue and reference it. Entries must name what about the sample makes
    /// the two closures genuinely different, not merely that they are.
    /// </para>
    /// </summary>
    private static readonly Dictionary<string, string> KnownDifferences =
        new(StringComparer.Ordinal)
        {
        };

    /// <summary>
    /// Samples whose ref-pack compile still emits an <c>AssemblyRef</c> to
    /// <c>System.Private.CoreLib</c>, keyed by file with the reason — the
    /// #3716 guard-rail idiom again. Every entry here is a <b>known defect</b>
    /// (#3718), not an accepted behaviour; the list is a burn-down, and the
    /// assertion fails in <em>both</em> directions — an unlisted leak and a
    /// listed sample that has stopped leaking — so fixing a lowering site
    /// forces the corresponding entries out.
    /// </summary>
    private static readonly Dictionary<string, string> KnownRefPackCorlibLeaks =
        new(StringComparer.Ordinal)
        {
            ["AddressBook.gs"] = Issue3718,
            ["AnonymousVariadicFunctionType.gs"] = Issue3718,
            ["ArrowFunctionTypeClause.gs"] = Issue3718,
            ["AsyncAwaitInLoop.gs"] = Issue3718,
            ["AsyncAwaitInNestedLoop.gs"] = Issue3718,
            ["AsyncClassMethod.gs"] = Issue3718,
            ["AsyncGoScopeJoin.gs"] = Issue3718,
            ["AsyncMultiAwaitInLoop.gs"] = Issue3718,
            ["AsyncTask.gs"] = Issue3718,
            ["AsyncValueReturns.gs"] = Issue3718,
            ["Channels.gs"] = Issue3718,
            ["CountWords.gs"] = Issue3718,
            ["DataStruct.gs"] = Issue3718,
            ["DataStructErgonomics.gs"] = Issue3718,
            ["DefaultExpression.gs"] = Issue3718,
            ["DefaultInterfaceMethods.gs"] = Issue3718,
            ["DiscriminatedUnion.gs"] = Issue3718,
            ["Exhaustiveness.gs"] = Issue3718,
            ["ExpressionEval.gs"] = Issue3718,
            ["GenericMethodUserTypeArg.gs"] = Issue3718,
            ["GenericNamedDelegate.gs"] = Issue3718,
            ["GenericTypeParameterAsTypeArgument.gs"] = Issue3718,
            ["GoBuiltinsGated.gs"] = Issue3718,
            ["GoChannelsGated.gs"] = Issue3718,
            ["GoScope.gs"] = Issue3718,
            ["GsharpExtensionsMixed.gs"] = Issue3718,
            ["GsharpExtensionsOptional.gs"] = Issue3718,
            ["GsharpExtensionsSequences.gs"] = Issue3718,
            ["IfLetGuardLet.gs"] = Issue3718,
            ["InterfaceUpcast.gs"] = Issue3718,
            ["InterpolatedString.gs"] = Issue3718,
            ["InterpolatedStringFormat.gs"] = Issue3718,
            ["InterpolatedStringFormattable.gs"] = Issue3718,
            ["InterpolatedStringRichHoles.gs"] = Issue3718,
            ["Loop.gs"] = Issue3718,
            ["MapForIn.gs"] = Issue3718,
            ["NamedArguments.gs"] = Issue3718,
            ["NamedTupleElements.gs"] = Issue3718,
            ["NullableFlow.gs"] = Issue3718,
            ["NullCoalescingAssignment.gs"] = Issue3718,
            ["ParenthesizedReceiver.gs"] = Issue3718,
            ["Patterns.gs"] = Issue3718,
            ["PatternSwitch.gs"] = Issue3718,
            ["PInvokeLibraryImport.gs"] = Issue3718,
            ["PInvokeLibraryImportStringReturn.gs"] = Issue3718,
            ["PortScan.gs"] = Issue3718,
            ["PrimaryCtorVariadic.gs"] = Issue3718,
            ["Records.gs"] = Issue3718,
            ["ReifiedGenerics.gs"] = Issue3718,
            ["Sealed.gs"] = Issue3718,
            ["Select.gs"] = Issue3718,
            ["SliceLinqUntypedLambda.gs"] = Issue3718,
            ["SlicePattern.gs"] = Issue3718,
            ["SpanComprehensive.gs"] = Issue3718,
            ["SwitchExpression.gs"] = Issue3718,
            ["TupleArrowElements.gs"] = Issue3718,
            ["TupleEquality.gs"] = Issue3718,
            ["TupleSequenceIterators.gs"] = Issue3718,
            ["UserRefStruct.gs"] = Issue3718,
            ["ValueTypeObjectMethods.gs"] = Issue3718,
            ["Variadic.gs"] = Issue3718,
            ["VariadicDelegate.gs"] = Issue3718,
            ["VariadicMethods.gs"] = Issue3718,
            ["WhileAndLabeledLoops.gs"] = Issue3718,
            ["ZeroValues.gs"] = Issue3718,
        };

    public static IEnumerable<object[]> DifferentialSamples()
    {
        string samplesDirectory = LocateSamplesDirectory();
        if (samplesDirectory is null)
        {
            yield break;
        }

        if (!ReferenceClosure.IsRefPackAvailable())
        {
            // Degrade gracefully rather than emitting an empty theory (which
            // xUnit reports as an error): one row that reports the missing
            // prerequisite by name.
            yield return new object[] { null };
            yield break;
        }

        bool fullCorpus = string.Equals(
            Environment.GetEnvironmentVariable(FullCorpusEnvironmentVariable),
            "1",
            StringComparison.Ordinal);

        foreach (string sample in SampleConformanceData.GetSingleFileSamples(samplesDirectory))
        {
            if (!fullCorpus && !AlwaysOnSamples.Contains(sample, StringComparer.Ordinal))
            {
                continue;
            }

            if (OperatingSystem.IsWindows() && sample.StartsWith("PInvoke", StringComparison.Ordinal))
            {
                continue;
            }

            yield return new object[] { sample };
        }
    }

    /// <summary>
    /// Compiles the sample against both reference closures and fails on any
    /// unlisted divergence.
    /// </summary>
    /// <param name="sampleName">The sample file name.</param>
    /// <returns>A task representing the asynchronous test.</returns>
    [Theory]
    [MemberData(nameof(DifferentialSamples))]
    public async Task Sample_AgreesAcrossReferenceClosures(string sampleName)
    {
        if (sampleName is null)
        {
            Assert.True(
                ReferenceClosure.UnavailableReason is not null,
                "the differential was skipped without a recorded reason");
            return;
        }

        string samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);
        string sourcePath = Path.Combine(samplesDirectory, sampleName);
        string goldenPath = Path.ChangeExtension(sourcePath, ".golden");

        DriverConformanceHarness.DifferentialOutcome outcome =
            await DriverConformanceHarness.RunDifferentialAsync(
                sampleName,
                new[] { sourcePath },
                File.Exists(goldenPath) ? goldenPath : null);

        AssertBothClosuresWereRealised(outcome);
        AssertRefPackCompileStaysInItsClosure(outcome);

        if (KnownDifferences.TryGetValue(sampleName, out string reason))
        {
            Assert.True(
                outcome.Differences.Count > 0,
                $"{sampleName} is listed in KnownDifferences ({reason}) but the two reference "
                    + "closures now agree. Remove the entry.");
            return;
        }

        Assert.True(
            outcome.Differences.Count == 0,
            $"{sampleName} compiles differently against the host TPA and against the "
                + "Microsoft.NETCore.App.Ref closure. This is the load-context defect signature "
                + "(issue #3717): a host `typeof(X).IsAssignableFrom(clrType)` or equivalent is "
                + "taking a different arm for MetadataLoadContext types. Triage it — file an "
                + "issue if it is a defect; only add it to KnownDifferences with a reason if the "
                + "divergence is legitimate.\n\n"
                + string.Join("\n\n", outcome.Differences));
    }

    /// <summary>
    /// The vacuity guard the differential itself needs: a green run proves
    /// nothing if the "ref-pack" compile silently resolved from the host TPA
    /// anyway — the same concern the #3705 load-context differential tests
    /// caught in themselves.
    /// <para>
    /// The evidence is in the emitted <c>AssemblyRef</c> table. A compile that
    /// bound against live runtime types names the implementation assembly
    /// <c>System.Private.CoreLib</c>; a compile that bound through a
    /// <see cref="System.Reflection.MetadataLoadContext"/> over the targeting
    /// pack names the <c>System.Runtime</c> contract. Both must be present, on
    /// their respective sides, or the two modes were not two modes.
    /// </para>
    /// </summary>
    /// <param name="outcome">The differential outcome.</param>
    private static void AssertBothClosuresWereRealised(
        DriverConformanceHarness.DifferentialOutcome outcome)
    {
        Assert.True(
            outcome.HostTpaAssemblyReferences.Contains(ImplementationCorlib, StringComparer.Ordinal),
            $"{outcome.Sample}: the host-TPA compile did not reference {ImplementationCorlib} "
                + $"(refs: [{string.Join(", ", outcome.HostTpaAssemblyReferences)}]), so it did "
                + "not bind against live runtime types and the differential is vacuous.");
        Assert.True(
            outcome.RefPackAssemblyReferences.Contains(ContractCorlib, StringComparer.Ordinal),
            $"{outcome.Sample}: the ref-pack compile did not reference {ContractCorlib} "
                + $"(refs: [{string.Join(", ", outcome.RefPackAssemblyReferences)}]), so it did "
                + "not bind through the targeting pack and the differential is vacuous.");
    }

    /// <summary>
    /// The ref-pack compile must not reach past its reference closure into the
    /// host runtime. An <c>AssemblyRef</c> to <c>System.Private.CoreLib</c> in
    /// an assembly compiled entirely against the targeting pack means some
    /// compiler path resolved a well-known type with a host <c>typeof</c>
    /// instead of the compilation's load context — the #3717 family's other
    /// face, invisible to the IL comparison because that comparison
    /// deliberately normalises assembly identity away.
    /// </summary>
    /// <param name="outcome">The differential outcome.</param>
    private static void AssertRefPackCompileStaysInItsClosure(
        DriverConformanceHarness.DifferentialOutcome outcome)
    {
        if (!outcome.RefPackAssemblyReferences.Contains(ImplementationCorlib, StringComparer.Ordinal))
        {
            Assert.False(
                KnownRefPackCorlibLeaks.ContainsKey(outcome.Sample),
                $"{outcome.Sample} is listed in KnownRefPackCorlibLeaks but its ref-pack compile "
                    + $"no longer references {ImplementationCorlib}. Remove the entry.");
            return;
        }

        Assert.True(
            KnownRefPackCorlibLeaks.ContainsKey(outcome.Sample),
            $"{outcome.Sample}: the ref-pack compile emitted an AssemblyRef to "
                + $"{ImplementationCorlib} even though it was compiled entirely against the "
                + "Microsoft.NETCore.App.Ref closure (refs: "
                + $"[{string.Join(", ", outcome.RefPackAssemblyReferences)}]). Some compiler path "
                + "resolved a well-known type through the host runtime instead of the "
                + "compilation's MetadataLoadContext. Fix it, or record it here with an issue "
                + "number.");
    }

    /// <summary>
    /// Guards the per-PR subset against silent shrinkage, and against listing
    /// a sample that no longer exists.
    /// </summary>
    [Fact]
    public void AlwaysOnSubset_IsPresentAndNonVacuous()
    {
        string samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);

        var available = SampleConformanceData.GetSingleFileSamples(samplesDirectory)
            .ToHashSet(StringComparer.Ordinal);
        string[] missing = AlwaysOnSamples
            .Where(sample => !available.Contains(sample))
            .ToArray();
        Assert.True(
            missing.Length == 0,
            "AlwaysOnSamples names samples that no longer exist: " + string.Join(", ", missing));

        // The subset must keep covering the shapes this defect family attacks,
        // or it would run green forever while the nightly does the real work.
        string[] sources = AlwaysOnSamples
            .Select(sample => File.ReadAllText(Path.Combine(samplesDirectory, sample)))
            .ToArray();
        Assert.True(
            sources.Count(text => text.Contains("for ", StringComparison.Ordinal)) >= 4,
            "AlwaysOnSamples must keep at least four `for … in` samples — the #3708 shape.");
        Assert.Contains(sources, text => text.Contains("+=", StringComparison.Ordinal));
        Assert.Contains(sources, text => text.Contains("Gsharp.Extensions", StringComparison.Ordinal));
    }

    /// <summary>
    /// Every allow-listed entry must carry a reason and name a sample that
    /// still exists, so neither list can rot into a set of stale keys that
    /// silently stop guarding anything.
    /// </summary>
    [Fact]
    public void AllowLists_CarryReasonsAndNameLiveSamples()
    {
        string samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);
        var available = SampleConformanceData.GetSingleFileSamples(samplesDirectory)
            .ToHashSet(StringComparer.Ordinal);

        foreach (KeyValuePair<string, string> entry in
            KnownDifferences.Concat(KnownRefPackCorlibLeaks))
        {
            Assert.False(
                string.IsNullOrWhiteSpace(entry.Value),
                $"{entry.Key} is allow-listed without a reason.");
            Assert.True(
                available.Contains(entry.Key),
                $"{entry.Key} is allow-listed but is not a sample any more.");
        }
    }

    private static string LocateSamplesDirectory()
        => SampleConformanceData.LocateSamplesDirectory(
            typeof(DifferentialReferenceClosureTests).Assembly);
}
