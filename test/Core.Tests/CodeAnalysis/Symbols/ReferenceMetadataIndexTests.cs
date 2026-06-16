// <copyright file="ReferenceMetadataIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Tests for <see cref="ReferenceMetadataIndex"/> and the warm-resolution path it
/// drives on <see cref="ReferenceResolver"/> (ADR-0107). The load-bearing property
/// is that resolving through a persisted/round-tripped index yields results
/// identical to the cold, from-scratch eager index. The index is persisted as a
/// human-readable text section (ADR-0107 revised: single `.lscache` text file, no
/// binary blob).
/// </summary>
public class ReferenceMetadataIndexTests
{
    // A curated mix of types that must resolve (top-level, generic, BCL, a
    // forwarded System type) plus a name that must not, exercised against both
    // the cold and warm paths.
    private static readonly string[] CuratedNames =
    {
        "GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver",
        "System.String",
        "System.Console",
        "System.Object",
        "System.Collections.Generic.List`1",
        "System.Collections.Generic.Dictionary`2",
        "System.Threading.Tasks.Task`1",
        "Definitely.Not.A.Real.Type",
    };

    private static string[] CoreReferenceSet()
    {
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        Assert.False(string.IsNullOrEmpty(corePath));
        return new[] { corePath };
    }

    private static string WriteSection(ReferenceMetadataIndex index)
    {
        using var writer = new System.IO.StringWriter();
        index.WriteTextSection(writer);
        return writer.ToString();
    }

    private static IReadOnlyList<string> SplitLines(string text)
    {
        // Mirror File.ReadAllLines: split on '\n', strip trailing '\r', drop the
        // empty trailing entry produced by the final newline.
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        if (lines.Count > 0 && lines[lines.Count - 1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return lines;
    }

    [Fact]
    public void Export_Then_RoundTrip_Preserves_Identities_And_Names()
    {
        using var cold = ReferenceResolver.WithReferences(CoreReferenceSet());
        var index = cold.ExportMetadataIndex();

        var lines = SplitLines(WriteSection(index));

        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var roundTripped));
        Assert.True(index.AssemblyIdentities.SequenceEqual(roundTripped.AssemblyIdentities));
        Assert.Equal(index.ToNameIndex().Count, roundTripped.ToNameIndex().Count);
        Assert.True(index.ToNameIndex().Count > 0);
    }

    [Fact]
    public void Section_Is_Human_Readable_And_Last()
    {
        using var cold = ReferenceResolver.WithReferences(CoreReferenceSet());
        var text = WriteSection(cold.ExportMetadataIndex());

        Assert.StartsWith(ReferenceMetadataIndex.SectionHeader, text);
        Assert.Contains("formatVersion=", text);
        Assert.Contains("assemblyCount=", text);
        Assert.Contains("assembly=", text);
        Assert.Contains("typeNameCount=", text);
    }

    [Fact]
    public void RoundTrip_Survives_A_Descriptor_Preamble_Before_The_Section()
    {
        using var cold = ReferenceResolver.WithReferences(CoreReferenceSet());
        var index = cold.ExportMetadataIndex();

        // The real descriptor places header sections before [metadataIndex];
        // TryReadTextSection must locate the header among them.
        var preamble = "version=2\n# comment\n\n[project]\nname=Sample\n\n";
        var lines = SplitLines(preamble + WriteSection(index));

        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var parsed));
        Assert.Equal(index.ToNameIndex().Count, parsed.ToNameIndex().Count);
    }

    [Fact]
    public void WarmResolution_Equals_ColdResolution_For_Every_Indexed_Name()
    {
        var references = CoreReferenceSet();
        using var cold = ReferenceResolver.WithReferences(references);
        var index = cold.ExportMetadataIndex();

        using var warm = ReferenceResolver.WithReferences(references);
        Assert.True(warm.TryUseMetadataIndex(index));

        // Cap the exhaustive loop so the test stays fast on a large closure, then
        // always include the curated names (which include a forwarded type).
        var indexedNames = index.ToNameIndex().Keys.Take(4000);
        foreach (var name in indexedNames.Concat(CuratedNames))
        {
            var coldFound = cold.TryResolveType(name, out var coldType);
            var warmFound = warm.TryResolveType(name, out var warmType);

            Assert.Equal(coldFound, warmFound);
            if (coldFound)
            {
                Assert.Equal(coldType.FullName, warmType.FullName);
                Assert.Equal(coldType.Assembly.GetName().FullName, warmType.Assembly.GetName().FullName);
            }
            else
            {
                Assert.Null(warmType);
            }
        }
    }

    [Fact]
    public void WarmResolution_Returns_Miss_For_Unknown_Type()
    {
        var references = CoreReferenceSet();
        using var cold = ReferenceResolver.WithReferences(references);
        using var warm = ReferenceResolver.WithReferences(references);
        Assert.True(warm.TryUseMetadataIndex(cold.ExportMetadataIndex()));

        Assert.False(warm.TryResolveType("No.Such.Namespace.NoSuchType", out var type));
        Assert.Null(type);
    }

    [Fact]
    public void Deserialized_Index_Drives_Warm_Resolution()
    {
        var references = CoreReferenceSet();
        using var producer = ReferenceResolver.WithReferences(references);

        var lines = SplitLines(WriteSection(producer.ExportMetadataIndex()));
        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var index));

        using var consumer = ReferenceResolver.WithReferences(references);
        Assert.True(consumer.TryUseMetadataIndex(index));
        Assert.True(consumer.TryResolveType("System.String", out var stringType));
        Assert.Equal("System.String", stringType.FullName);
    }

    [Fact]
    public void TryUseMetadataIndex_Rejects_Index_From_A_Different_Reference_Set()
    {
        using var core = ReferenceResolver.WithReferences(CoreReferenceSet());
        var coreIndex = core.ExportMetadataIndex();

        // A resolver over a different assembly set has different assembly
        // identities, so the payload must be rejected (defence in depth).
        var otherPath = typeof(Xunit.FactAttribute).Assembly.Location;
        using var other = ReferenceResolver.WithReferences(new[] { otherPath });
        Assert.False(other.TryUseMetadataIndex(coreIndex));
    }

    [Fact]
    public void TryUseMetadataIndex_Rejects_Null()
    {
        using var resolver = ReferenceResolver.WithReferences(CoreReferenceSet());
        Assert.False(resolver.TryUseMetadataIndex(null));
    }

    [Fact]
    public void TryReadTextSection_Rejects_Null()
    {
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(null, out var index));
        Assert.Null(index);
    }

    [Fact]
    public void TryReadTextSection_Rejects_Missing_Header()
    {
        var lines = new[] { "version=2", "[project]", "name=Sample" };
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index));
        Assert.Null(index);
    }

    [Fact]
    public void TryReadTextSection_Rejects_Truncated_Payload()
    {
        using var producer = ReferenceResolver.WithReferences(CoreReferenceSet());
        var lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList();

        // Lop off the back half so the per-entry name reads run out of data.
        var truncated = lines.Take(lines.Count / 2).ToList();
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(truncated, out var index));
        Assert.Null(index);
    }

    [Fact]
    public void TryReadTextSection_Rejects_Wrong_Format_Version()
    {
        using var producer = ReferenceResolver.WithReferences(CoreReferenceSet());
        var lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList();

        var idx = lines.FindIndex(l => l.StartsWith("formatVersion=", StringComparison.Ordinal));
        Assert.True(idx >= 0);
        lines[idx] = "formatVersion=999";

        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index));
        Assert.Null(index);
    }

    [Fact]
    public void TryReadTextSection_Rejects_Corrupt_Count()
    {
        using var producer = ReferenceResolver.WithReferences(CoreReferenceSet());
        var lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList();

        var idx = lines.FindIndex(l => l.StartsWith("typeNameCount=", StringComparison.Ordinal));
        Assert.True(idx >= 0);
        lines[idx] = "typeNameCount=not-a-number";

        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index));
        Assert.Null(index);
    }

    [Fact]
    public void Create_Rejects_Mismatched_Array_Lengths()
    {
        var identities = System.Collections.Immutable.ImmutableArray.Create("A", "B");
        var names = System.Collections.Immutable.ImmutableArray.Create(
            System.Collections.Immutable.ImmutableArray<string>.Empty);

        Assert.Throws<ArgumentException>(() => ReferenceMetadataIndex.Create(identities, names));
    }

    [Fact]
    public void ToNameIndex_Uses_First_Writer_Wins()
    {
        var identities = System.Collections.Immutable.ImmutableArray.Create("Asm0", "Asm1");
        var names = System.Collections.Immutable.ImmutableArray.Create(
            System.Collections.Immutable.ImmutableArray.Create("Dup", "OnlyIn0"),
            System.Collections.Immutable.ImmutableArray.Create("Dup", "OnlyIn1"));

        var index = ReferenceMetadataIndex.Create(identities, names);
        var map = index.ToNameIndex();

        Assert.Equal(0, map["Dup"]);
        Assert.Equal(0, map["OnlyIn0"]);
        Assert.Equal(1, map["OnlyIn1"]);
    }

    [Fact]
    public void Manually_Authored_Section_Round_Trips()
    {
        // The text section is human-authorable; a hand-written section with
        // interleaved comments/blank lines must parse to the expected index.
        var lines = SplitLines(
            ReferenceMetadataIndex.SectionHeader + "\n" +
            "# a comment\n" +
            "formatVersion=" + ReferenceMetadataIndex.FormatVersion + "\n" +
            "assemblyCount=2\n" +
            "\n" +
            "assembly=Asm0\n" +
            "typeNameCount=2\n" +
            "Ns.A\n" +
            "Ns.B\n" +
            "\n" +
            "assembly=Asm1\n" +
            "typeNameCount=1\n" +
            "Ns.C\n");

        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var index));
        Assert.Equal(new[] { "Asm0", "Asm1" }, index.AssemblyIdentities);
        var map = index.ToNameIndex();
        Assert.Equal(0, map["Ns.A"]);
        Assert.Equal(0, map["Ns.B"]);
        Assert.Equal(1, map["Ns.C"]);
    }
}
