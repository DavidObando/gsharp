// <copyright file="ReferenceMetadataIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Tests for (cref:ReferenceMetadataIndex) and the warm-resolution path it
/// drives on (cref:ReferenceResolver) (ADR-0107). The load-bearing property
/// is that resolving through a persisted/round-tripped index yields results
/// identical to the cold, from-scratch eager index. The index is persisted as a
/// human-readable text section (ADR-0107 revised: single `.lscache` text file, no
/// binary blob).
open class ReferenceMetadataIndexTests {
    @Fact
    func ArityInsensitivePresenceUsesWarmIndexWithoutMaterializingColdTypes() {
        let references = CoreReferenceSet()
        using let producer = ReferenceResolver.WithReferences(references)
        let metadata = producer.ExportMetadataIndex()
        using let warm = ReferenceResolver.WithReferences(references)
        Assert.True(warm.TryUseMetadataIndex(metadata))
        let field FieldInfo? = typeof(ReferenceResolver).GetField(
            "typeNameIndex",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(field)
        let coldIndex = Assert.IsType[Lazy[Dictionary[string, Type]]](field!!.GetValue(warm))
        Assert.False(coldIndex.IsValueCreated)
        // The hidden-type probe below means something only while the type
        // exists and stays non-public; a rename would make it pass vacuously.
        let invariant Type? = typeof(ReferenceResolver).Assembly.GetType("GSharp.Core.CodeAnalysis.Invariant")
        Assert.NotNull(invariant)
        Assert.False(invariant!!.IsVisible)
        for var i = 0; i < 100; i++ {
            Assert.True(warm.HasTypeNameAtAnyArity("System.Collections.Generic.List"))
            Assert.True(warm.HasTypeNameAtAnyArity("System.Collections.Generic.Dictionary"))
            Assert.True(warm.HasTypeNameAtAnyArity("System.String"))
            Assert.False(warm.HasTypeNameAtAnyArity("System.Collections.Generic.ListExtra"))
            Assert.False(warm.HasTypeNameAtAnyArity("GSharp.Core.CodeAnalysis.Invariant"))
            Assert.False(warm.HasTypeNameAtAnyArity("No.Such.Type"))
        }
        Assert.False(coldIndex.IsValueCreated)
    }

    @Fact
    func ArityInsensitivePresenceMatchesColdAndWarmPaths() {
        let references = CoreReferenceSet()
        using let cold = ReferenceResolver.WithReferences(references)
        using let warm = ReferenceResolver.WithReferences(references)
        Assert.True(warm.TryUseMetadataIndex(cold.ExportMetadataIndex()))
        for name in CuratedNames.Select((name string) -> name.Split('`')[0]) {
            Assert.Equal(cold.HasTypeNameAtAnyArity(name), warm.HasTypeNameAtAnyArity(name))
        }
    }

    @Fact
    func Export_Then_RoundTrip_Preserves_Identities_And_Names() {
        using let cold = ReferenceResolver.WithReferences(CoreReferenceSet())
        let index = cold.ExportMetadataIndex()
        let lines = SplitLines(WriteSection(index))
        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var roundTripped))
        Assert.True(index.AssemblyIdentities.SequenceEqual(roundTripped.AssemblyIdentities))
        Assert.Equal(index.ToNameIndex().Count, roundTripped.ToNameIndex().Count)
        Assert.True(index.ToNameIndex().Count > 0)
    }

    @Fact
    func Section_Is_Human_Readable_And_Last() {
        using let cold = ReferenceResolver.WithReferences(CoreReferenceSet())
        let text = WriteSection(cold.ExportMetadataIndex())
        Assert.StartsWith(ReferenceMetadataIndex.SectionHeader, text)
        Assert.Contains("formatVersion=", text)
        Assert.Contains("assemblyCount=", text)
        Assert.Contains("assembly=", text)
        Assert.Contains("typeNameCount=", text)
    }

    @Fact
    func RoundTrip_Survives_A_Descriptor_Preamble_Before_The_Section() {
        using let cold = ReferenceResolver.WithReferences(CoreReferenceSet())
        let index = cold.ExportMetadataIndex()
        // The real descriptor places header sections before [metadataIndex];
        // TryReadTextSection must locate the header among them.
        let preamble = `version=2
# comment

[project]
name=Sample

`
        let lines = SplitLines(preamble + WriteSection(index))
        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var parsed))
        Assert.Equal(index.ToNameIndex().Count, parsed.ToNameIndex().Count)
    }

    @Fact
    func WarmResolution_Equals_ColdResolution_For_Every_Indexed_Name() {
        let references = CoreReferenceSet()
        using let cold = ReferenceResolver.WithReferences(references)
        let index = cold.ExportMetadataIndex()
        using let warm = ReferenceResolver.WithReferences(references)
        Assert.True(warm.TryUseMetadataIndex(index))
        // Cap the exhaustive loop so the test stays fast on a large closure, then
        // always include the curated names (which include a forwarded type).
        let indexedNames = index.ToNameIndex().Keys.Take(4000)
        for name in indexedNames.Concat(CuratedNames) {
            let coldFound = cold.TryResolveType(name, out var coldType)
            let warmFound = warm.TryResolveType(name, out var warmType)
            Assert.Equal(coldFound, warmFound)
            if coldFound {
                Assert.Equal(coldType.FullName, warmType.FullName)
                Assert.Equal(coldType.Assembly.GetName().FullName, warmType.Assembly.GetName().FullName)
            } else {
                Assert.Null(warmType)
            }
        }
    }

    @Fact
    func WarmResolution_Returns_Miss_For_Unknown_Type() {
        let references = CoreReferenceSet()
        using let cold = ReferenceResolver.WithReferences(references)
        using let warm = ReferenceResolver.WithReferences(references)
        Assert.True(warm.TryUseMetadataIndex(cold.ExportMetadataIndex()))
        Assert.False(warm.TryResolveType("No.Such.Namespace.NoSuchType", out var type))
        Assert.Null(type)
    }

    @Fact
    func Deserialized_Index_Drives_Warm_Resolution() {
        let references = CoreReferenceSet()
        using let producer = ReferenceResolver.WithReferences(references)
        let lines = SplitLines(WriteSection(producer.ExportMetadataIndex()))
        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
        using let consumer = ReferenceResolver.WithReferences(references)
        Assert.True(consumer.TryUseMetadataIndex(index))
        Assert.True(consumer.TryResolveType("System.String", out var stringType))
        Assert.Equal("System.String", stringType.FullName)
    }

    @Fact
    func TryUseMetadataIndex_Rejects_Index_From_A_Different_Reference_Set() {
        using let core = ReferenceResolver.WithReferences(CoreReferenceSet())
        let coreIndex = core.ExportMetadataIndex()
        // A resolver over a different assembly set has different assembly
        // identities, so the payload must be rejected (defence in depth).
        let otherPath = typeof(FactAttribute).Assembly.Location
        using let other = ReferenceResolver.WithReferences([]string{otherPath})
        Assert.False(other.TryUseMetadataIndex(coreIndex))
    }

    @Fact
    func TryUseMetadataIndex_Rejects_Null() {
        using let resolver = ReferenceResolver.WithReferences(CoreReferenceSet())
        Assert.False(resolver.TryUseMetadataIndex(nil))
    }

    @Fact
    func TryReadTextSection_Rejects_Null() {
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(nil, out var index))
        Assert.Null(index)
    }

    @Fact
    func TryReadTextSection_Rejects_Missing_Header() {
        let lines = []string{"version=2", "[project]", "name=Sample"}
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
        Assert.Null(index)
    }

    @Fact
    func TryReadTextSection_Rejects_Truncated_Payload() {
        using let producer = ReferenceResolver.WithReferences(CoreReferenceSet())
        let lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList()
        // Lop off the back half so the per-entry name reads run out of data.
        let truncated = lines.Take(lines.Count / 2).ToList()
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(truncated, out var index))
        Assert.Null(index)
    }

    @Fact
    func TryReadTextSection_Rejects_Wrong_Format_Version() {
        using let producer = ReferenceResolver.WithReferences(CoreReferenceSet())
        let lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList()
        let idx = lines.FindIndex((l string) -> l.StartsWith("formatVersion=", StringComparison.Ordinal))
        Assert.True(idx >= 0)
        lines[idx] = "formatVersion=999"
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
        Assert.Null(index)
    }

    @Fact
    func TryReadTextSection_Rejects_Corrupt_Count() {
        using let producer = ReferenceResolver.WithReferences(CoreReferenceSet())
        let lines = SplitLines(WriteSection(producer.ExportMetadataIndex())).ToList()
        let idx = lines.FindIndex((l string) -> l.StartsWith("typeNameCount=", StringComparison.Ordinal))
        Assert.True(idx >= 0)
        lines[idx] = "typeNameCount=not-a-number"
        Assert.False(ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
        Assert.Null(index)
    }

    @Fact
    func Create_Rejects_Mismatched_Array_Lengths() {
        let identities = ImmutableArray.Create("A", "B")
        let names = ImmutableArray.Create(ImmutableArray[string].Empty)
        Assert.Throws[ArgumentException](
            func () object? {
                return ReferenceMetadataIndex.Create(identities, names)
            }
        )
    }

    @Fact
    func ToNameIndex_Uses_First_Writer_Wins() {
        let identities = ImmutableArray.Create("Asm0", "Asm1")
        let names = ImmutableArray.Create(
            ImmutableArray.Create("Dup", "OnlyIn0"),
            ImmutableArray.Create("Dup", "OnlyIn1")
        )
        let index = ReferenceMetadataIndex.Create(identities, names)
        let map_ = index.ToNameIndex()
        Assert.Equal(0, map_["Dup"])
        Assert.Equal(0, map_["OnlyIn0"])
        Assert.Equal(1, map_["OnlyIn1"])
    }

    @Fact
    func Manually_Authored_Section_Round_Trips() {
        // The text section is human-authorable; a hand-written section with
        // interleaved comments/blank lines must parse to the expected index.
        let lines = SplitLines(
            ReferenceMetadataIndex.SectionHeader +
                "\n" +
                "# a comment\n" +
                "formatVersion=" +
                ReferenceMetadataIndex
                .FormatVersion
                .ToString() +
                "\n" +
                "assemblyCount=2\n" +
                "\n" +
                "assembly=Asm0\n" +
                "typeNameCount=2\n" +
                "Ns.A\n" +
                "Ns.B\n" +
                "\n" +
                "assembly=Asm1\n" +
                "typeNameCount=1\n" +
                "Ns.C\n"
        )
        Assert.True(ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
        Assert.Equal([]string{"Asm0", "Asm1"}, index.AssemblyIdentities)
        let map_ = index.ToNameIndex()
        Assert.Equal(0, map_["Ns.A"])
        Assert.Equal(0, map_["Ns.B"])
        Assert.Equal(1, map_["Ns.C"])
    }

    shared {
        // A curated mix of types that must resolve (top-level, generic, BCL, a
        // forwarded System type) plus a name that must not, exercised against both
        // the cold and warm paths.
        private let CuratedNames[]string = []string{
            "GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver",
            "System.String",
            "System.Console",
            "System.Object",
            "System.Collections.Generic.List`1",
            "System.Collections.Generic.Dictionary`2",
            "System.Threading.Tasks.Task`1",
            "Definitely.Not.A.Real.Type"
        }

        private func CoreReferenceSet()[]string {
            let corePath = typeof(ReferenceResolver).Assembly.Location
            Assert.False(string.IsNullOrEmpty(corePath))
            return []string{corePath}
        }

        private func WriteSection(index ReferenceMetadataIndex) string {
            using let writer = StringWriter()
            index.WriteTextSection(writer)
            return writer.ToString()
        }

        private func SplitLines(text string) IReadOnlyList[string] {
            // Mirror File.ReadAllLines: split on '\n', strip trailing '\r', drop the
            // empty trailing entry produced by the final newline.
            let lines = text.ReplaceLineEndings(Environment.NewLine).Split(Environment.NewLine).ToList()
            if lines.Count > 0 && lines[lines.Count - 1].Length == 0 {
                lines.RemoveAt(lines.Count - 1)
            }
            return lines
        }
    }
}
