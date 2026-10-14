// <copyright file="CorePublicApiAllowanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.PublicApi

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests

/// ADR-0199 / #4654: the Core public-API snapshot tolerates exactly the listed
/// record `Deconstruct` additions and nothing else. Each test pairs the
/// allowance with the real golden comparison, so a wider allowance (or a
/// removed one) flips an assertion here.
class CorePublicApiAllowanceTests : IDisposable {
    private let directory string = Path.Combine(Path.GetTempPath(), "adr0199-" + Guid.NewGuid().ToString("N"))

    init() {
        Directory.CreateDirectory(this.directory)
    }

    func Dispose() {
        Directory.Delete(this.directory, recursive: true)
    }

    @Fact
    func ListedDeconstructOnRecord_IsRemovedAndReported() {
        let golden = NativeSurface()
        let migrated = WithMember(golden, Deconstruct)
        let result = CorePublicApiAllowance.Apply(migrated, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.Equal(golden, result.Lines)
        Assert.Equal(
            []string{
                CorePublicApiAllowanceTests.Record + " | method public Void Deconstruct(out Int32 A, out Int32 B)"
            },
            result.Present
        )
        Assert.True(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func MatchingAdditionInNonGscAssembly_StillFails() {
        let golden = NativeSurface()
        let native = WithMember(golden, Deconstruct)
        let result = CorePublicApiAllowance.Apply(
            native,
            Allow(CorePublicApiAllowanceTests.Record, Deconstruct),
            builtByGsc: false
        )
        Assert.Empty(result.Present)
        Assert.False(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func IsBuiltByGsc_DistinguishesGscFromCSharpAssemblies() {
        using let csharp = CSharpFixture("namespace Demo; public record Pair(int A);")
        Assert.False(CorePublicApiAllowance.IsBuiltByGsc(csharp.AssemblyPath))
        // The marker string in an unrelated attribute must not count.
        using let lookalike = CSharpFixture(
            "[assembly: System.Reflection.AssemblyDescription(\"GSharp.TypeSemantics\")]\nnamespace Demo; public record Pair(int A);"
        )
        Assert.False(CorePublicApiAllowance.IsBuiltByGsc(lookalike.AssemblyPath))
        let tree = SyntaxTree.Parse(SourceText.From(`package Demo
data class Pair(A int32)
`))
        let compilation = Compilation(tree){IsLibrary = true}
        let path = Path.Combine(this.directory, "gsc.dll")
        {
            using let stream = File.Create(path)
            Assert.True(compilation.Emit(stream).Success)
        }
        Assert.True(CorePublicApiAllowance.IsBuiltByGsc(path))
    }

    @Fact
    func NativeSurface_PassesWithoutTheAllowedEntries() {
        let golden = NativeSurface()
        let result = CorePublicApiAllowance.Apply(golden, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.Empty(result.Present)
        Assert.True(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func UnlistedDeconstructOnRecord_StillFails() {
        let golden = NativeSurface()
        let migrated = WithMember(golden, "  method public Void Deconstruct(out Int32 A)")
        let result = CorePublicApiAllowance.Apply(migrated, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.Empty(result.Present)
        Assert.False(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func ListedDeconstructOnOtherRecord_StillFails() {
        let golden = NativeSurface()
        let migrated = WithMember(golden, Deconstruct, "Demo.Other")
        let result = CorePublicApiAllowance.Apply(migrated, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.False(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func NonSynthesizedMemberOnRecord_StillFails() {
        let golden = NativeSurface()
        let migrated = WithMember(golden, "  method public Void Reset()")
        let result = CorePublicApiAllowance.Apply(migrated, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.False(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func NonDeconstructAllowanceEntry_IsRejected() {
        let migrated = WithMember(NativeSurface(), "  method public Void Reset()")
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CorePublicApiAllowance.Apply(
                    migrated,
                    Allow(CorePublicApiAllowanceTests.Record, "  method public Void Reset()")
                )
            }
        )
    }

    @Fact
    func ListedDeconstructOnNonRecord_IsRejected() {
        let migrated = WithMember(NativeSurface(), Deconstruct, "Demo.Plain")
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CorePublicApiAllowance.Apply(migrated, Allow("Demo.Plain", Deconstruct))
            }
        )
    }

    @Fact
    func DormantEntryOnNonRecord_IsRejectedEvenWhenAbsent() {
        Assert.Throws[InvalidOperationException](
            func () object? {
                return CorePublicApiAllowance.Apply(NativeSurface(), Allow("Demo.Plain", Deconstruct))
            }
        )
    }

    @Fact
    func RemovedExistingMember_StillFails() {
        let golden = NativeSurface()
        let migrated = golden.Where((line string) -> !line.Contains("get_B", StringComparison.Ordinal)).ToArray()
        let result = CorePublicApiAllowance.Apply(migrated, Allow(CorePublicApiAllowanceTests.Record, Deconstruct))
        Assert.False(Compare(golden, result.Lines).IsMatch)
    }

    @Fact
    func ShippedAllowance_ListsExactlyTheTenAdr0199RecordTypes() {
        let path = Path.Combine(
            CorePublicApiSnapshotTests.LocateRepoRoot(),
            "test",
            "Core.Tests",
            "Baselines",
            CorePublicApiAllowance.AllowanceFileName
        )
        let entries = CorePublicApiAllowance.Parse(File.ReadAllText(path))
        let expected[]string = []string{
            "GSharp.Core.CodeAnalysis.Binding.BoundAttributeArgument",
            "GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator",
            "GSharp.Core.CodeAnalysis.Binding.BoundCatchClause",
            "GSharp.Core.CodeAnalysis.Binding.BoundFieldInitializer",
            "GSharp.Core.CodeAnalysis.Binding.BoundMapEntry",
            "GSharp.Core.CodeAnalysis.Binding.BoundSelectCase",
            "GSharp.Core.CodeAnalysis.Binding.BoundUnaryOperator",
            "GSharp.Core.CodeAnalysis.Symbols.MarshalAsMetadata",
            "GSharp.Core.CodeAnalysis.Symbols.PInvokeMetadata",
            "GSharp.Core.CodeAnalysis.Symbols.StructLayoutMetadata"
        }
        Assert.Equal(
            expected,
            entries
                .Select((e CorePublicApiAllowance.Entry) -> e.TypeName)
                .OrderBy((n string) -> n, StringComparer.Ordinal)
                .ToArray()
        )
        Assert.All(
            entries,
            (e CorePublicApiAllowance.Entry) -> Assert.StartsWith(
                "  method public Void Deconstruct(",
                e.MemberLine,
                StringComparison.Ordinal
            )
        )
    }

    private func Compare(golden IReadOnlyList[string], actual IReadOnlyList[string]) GoldenFileComparison {
        let path = Path.Combine(this.directory, "golden.txt")
        File.WriteAllText(path, string.Join("\n", golden) + "\n")
        return GoldenFile.CompareFile(path, string.Join("\n", actual) + "\n", update: false)
    }

    shared {
        private const Record string = "Demo.Pair"
        private const Deconstruct string = "  method public Void Deconstruct(out Int32 A, out Int32 B)"
        private func NativeSurface()[]string -> []string{
            "type sealed class Demo.Other : System.Object",
            "  method public Demo.Other <Clone>$$()",
            "type sealed class Demo.Pair : System.Object",
            "  method public Demo.Pair <Clone>$$()",
            "  method public Int32 get_A()",
            "  method public Int32 get_B()",
            "type sealed class Demo.Plain : System.Object",
            "  method public Int32 get_A()"
        }

        private func Allow(type string, memberLine string) IReadOnlyList[
            CorePublicApiAllowance.Entry
        ] -> []CorePublicApiAllowance.Entry{CorePublicApiAllowance.Entry(type, memberLine)}

        private func WithMember(lines[]string, member string, type string = "Demo.Pair")[]string {
            let result = List[string](lines)
            let header = result.FindIndex(
                (line string) -> line.StartsWith("type ", StringComparison.Ordinal) && line.Contains(
                    " " + type + " ",
                    StringComparison.Ordinal
                )
            )
            result.Insert(header + 1, member)
            return result.ToArray()
        }
    }
}
