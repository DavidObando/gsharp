// <copyright file="PrinterExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Xunit;

namespace Cs2Gs.Tests.Coverage;

/// <summary>
/// Printer exhaustiveness contract: every concrete <see cref="GNode"/>
/// subclass has a <see cref="GNodeSamples"/> entry, and every sample prints
/// without throwing and re-parses cleanly with the real G# parser. Adding a
/// node type without printer support (or without a sample) fails here instead
/// of surfacing as an <see cref="ArgumentException"/> in production.
/// </summary>
public class PrinterExhaustivenessTests
{
    /// <summary>
    /// Samples that print but are EXPECTED to fail G# round-trip parsing
    /// because of a real printer/parser gap (not a malformed sample). Each
    /// entry is asserted to still fail: fixing the gap flips the test and
    /// forces removal from this list. Keep this list as small as possible.
    /// </summary>
    private static readonly IReadOnlyDictionary<Type, string> KnownRoundTripGaps = new Dictionary<Type, string>
    {
        [typeof(DeferStatement)] = "the printer renders `defer { … }` (block body) but the G# parser " +
            "only accepts `defer <expression>` (Parser.ParseDeferStatement; sample Defer.gs uses " +
            "`defer record(\"x\")`), so every printed DeferStatement fails to re-parse with GS0005.",
    };

    /// <summary>
    /// MemberData source: the simple name of every registered sample type,
    /// in deterministic ordinal order.
    /// </summary>
    /// <returns>One row per concrete <see cref="GNode"/> subclass.</returns>
    public static IEnumerable<object[]> SampleTypeNames() =>
        GNodeSamples.All.Keys
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .Select(t => new object[] { t.Name });

    [Fact]
    public void EveryConcreteGNodeTypeHasASample()
    {
        var concrete = ConcreteGNodeTypes();

        var missing = concrete
            .Where(t => !GNodeSamples.All.ContainsKey(t))
            .Select(t => t.FullName)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.True(
            missing.Count == 0,
            "Concrete GNode subclasses without a GNodeSamples entry:\n" +
            string.Join("\n", missing) +
            "\nAdd printer coverage plus a minimal sample in GNodeSamples, " +
            "then regenerate code-model-surface.golden.txt.");

        var stale = GNodeSamples.All.Keys
            .Where(t => !concrete.Contains(t))
            .Select(t => t.FullName)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.True(
            stale.Count == 0,
            "GNodeSamples entries that are no longer concrete GNode subclasses:\n" + string.Join("\n", stale));
    }

    [Fact]
    public void KnownRoundTripGapsOnlyListSampleTypes()
    {
        var unknown = KnownRoundTripGaps.Keys
            .Where(t => !GNodeSamples.All.ContainsKey(t))
            .Select(t => t.FullName)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.True(
            unknown.Count == 0,
            "KnownRoundTripGaps entries without a GNodeSamples entry:\n" + string.Join("\n", unknown));
    }

    [Theory]
    [MemberData(nameof(SampleTypeNames))]
    public void SamplePrintsAndRoundTrips(string typeName)
    {
        var type = GNodeSamples.All.Keys.Single(t => t.Name == typeName);
        var unit = GNodeSamples.All[type]();

        // Printing must not throw (the printer's `default:` cases throw
        // ArgumentException for unsupported nodes).
        var printed = GSharpPrinter.Print(unit);

        var result = GSharpRoundTrip.Validate(printed);
        if (KnownRoundTripGaps.TryGetValue(type, out var reason))
        {
            Assert.False(
                result.Success,
                $"{typeName} is listed in KnownRoundTripGaps (\"{reason}\") but now round-trips cleanly. " +
                $"The gap is fixed: remove it from the list.\nPrinted G#:\n{printed}");
            return;
        }

        Assert.True(
            result.Success,
            $"{typeName} sample printed but failed to re-parse.\nPrinted G#:\n{printed}\nParse errors:\n" +
            string.Join("\n", result.Errors));
    }

    private static IReadOnlyList<Type> ConcreteGNodeTypes() =>
        typeof(GNode).Assembly
            .GetExportedTypes()
            .Where(t => t.IsClass && !t.IsAbstract && typeof(GNode).IsAssignableFrom(t))
            .ToList();
}
