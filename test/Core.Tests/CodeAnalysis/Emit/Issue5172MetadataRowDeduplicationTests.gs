// <copyright file="Issue5172MetadataRowDeduplicationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5172: the emitter wrote the same `MemberRef`, `TypeSpec` and
/// `MethodSpec` row once per reference object instead of once per distinct
/// reference. These tests pin both layers: the interner returns the first
/// row for an equal row and keeps first-occurrence numbering, and a compiled
/// assembly has no two rows with the same encoded form.
open class Issue5172MetadataRowDeduplicationTests {
    @Fact
    func Interner_ReturnsTheFirstRow_ForAnEqualMemberRef() {
        let builder = MetadataBuilder()
        let rows = MetadataRowInterner(builder)
        let parent = builder.AddTypeReference(
            builder.AddAssemblyReference(
                builder.GetOrAddString("A"),
                Version(1, 0, 0, 0),
                default(StringHandle),
                default(BlobHandle),
                default(AssemblyFlags),
                default(BlobHandle)
            ),
            builder.GetOrAddString("N"),
            builder.GetOrAddString("T")
        )
        let name = builder.GetOrAddString("M")
        let first = rows.AddMemberReference(parent, name, builder.GetOrAddBlob([]uint8{0, 0, 1}))
        let again = rows.AddMemberReference(parent, name, builder.GetOrAddBlob([]uint8{0, 0, 1}))
        let otherSignature = rows.AddMemberReference(parent, name, builder.GetOrAddBlob([]uint8{0, 1, 1, 8}))
        let otherName = rows.AddMemberReference(
            parent,
            builder.GetOrAddString("N2"),
            builder.GetOrAddBlob([]uint8{0, 0, 1})
        )
        Assert.Equal(first, again)
        Assert.NotEqual(first, otherSignature)
        Assert.NotEqual(first, otherName)
        // First-occurrence numbering: rows 1, 2, 3 in the order first seen.
        Assert.Equal(1, MetadataTokens.GetRowNumber(first))
        Assert.Equal(2, MetadataTokens.GetRowNumber(otherSignature))
        Assert.Equal(3, MetadataTokens.GetRowNumber(otherName))
        Assert.Equal(3, builder.GetRowCount(TableIndex.MemberRef))
    }

    @Fact
    func Interner_ReturnsTheFirstRow_ForAnEqualTypeSpecAndMethodSpec() {
        let builder = MetadataBuilder()
        let rows = MetadataRowInterner(builder)
        let typeBlob = builder.GetOrAddBlob([]uint8{0x1D, 0x08})
        let otherTypeBlob = builder.GetOrAddBlob([]uint8{0x1D, 0x0E})
        let spec = rows.AddTypeSpecification(typeBlob)
        Assert.Equal(spec, rows.AddTypeSpecification(builder.GetOrAddBlob([]uint8{0x1D, 0x08})))
        Assert.NotEqual(spec, rows.AddTypeSpecification(otherTypeBlob))
        Assert.Equal(2, builder.GetRowCount(TableIndex.TypeSpec))
        let parent = builder.AddTypeReference(
            builder.AddAssemblyReference(
                builder.GetOrAddString("A"),
                Version(1, 0, 0, 0),
                default(StringHandle),
                default(BlobHandle),
                default(AssemblyFlags),
                default(BlobHandle)
            ),
            builder.GetOrAddString("N"),
            builder.GetOrAddString("T")
        )
        let method = rows.AddMemberReference(
            parent,
            builder.GetOrAddString("M"),
            builder.GetOrAddBlob([]uint8{0x10, 1, 1, 0x01, 0x1E, 0})
        )
        let instantiation = builder.GetOrAddBlob([]uint8{0x0A, 1, 0x08})
        let methodSpec = rows.AddMethodSpecification(method, instantiation)
        Assert.Equal(methodSpec, rows.AddMethodSpecification(method, builder.GetOrAddBlob([]uint8{0x0A, 1, 0x08})))
        Assert.NotEqual(methodSpec, rows.AddMethodSpecification(method, builder.GetOrAddBlob([]uint8{0x0A, 1, 0x0E})))
        Assert.Equal(2, builder.GetRowCount(TableIndex.MethodSpec))
    }

    @Fact
    func CompiledAssembly_HasNoRepeatedReferenceRows() {
        // Imported generic receivers, repeated generic method calls and a
        // user type as the type argument: the reference shapes that used to
        // repeat rows (symbol-keyed constructions, ctor and method refs).
        let source = `package P
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

class Clock {
    var Ticks int32
}

func Sum(xs ImmutableArray[int32]) int32 {
    var total = 0
    for var i = 0; i < xs.Length; i++ {
        total += xs[i]
    }
    return total
}

func Count(xs ImmutableArray[int32]) int32 {
    return xs.Length + Sum(xs)
}

func Pair(a Clock) List[Clock] {
    let l = List[Clock]()
    l.Add(a)
    l.Add(a)
    return l
}

func Other(a Clock) List[Clock] {
    let l = List[Clock]()
    l.Add(a)
    return l
}

var a = Array.Empty[Clock]()
var b = Array.Empty[Clock]()
var c = Array.Empty[Clock]()
Console.WriteLine(a.Length + b.Length + c.Length + Pair(Clock{}).Count + Other(Clock{}).Count)
Console.WriteLine(Count(ImmutableArray.Create(1, 2, 3)))`
        let repeats = RepeatedRows(Compile(source))
        Assert.True(repeats.Count == 0, string.Join("\n", repeats))
    }

    @Theory
    @InlineData("GenericMethodUserTypeArg.gs")
    @InlineData("SliceLinqUntypedLambda.gs")
    func Samples_HaveNoRepeatedReferenceRows(sample string) {
        let path = Path.Combine(LocateRepoRoot(), "samples", sample)
        let repeats = RepeatedRows(Compile(File.ReadAllText(path), sample))
        Assert.True(repeats.Count == 0, string.Join("\n", repeats))
    }

    /// Row numbering is a function of first occurrence only: compiling twice
    /// gives the same bytes.
    @Fact
    func EmittedAssembly_IsDeterministic() {
        let source = `package P
import System
import System.Collections.Generic

class Clock {
    var Ticks int32
}

var a = Array.Empty[Clock]()
var b = List[Clock]()
b.Add(Clock{})
Console.WriteLine(a.Length + b.Count)`
        Assert.Equal(Compile(source), Compile(source))
    }

    shared {
        private func Compile(source string, fileName string = "test.gs")[]uint8 {
            let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
            using let references = SampleReferences.CreateResolver()
            let compilation = Compilation(references, tree){
                DebugInformation = DebugInformationOptions{Deterministic: true}
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream: peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "GSharp.Issue5172",
                assemblyVersion: "1.0.0.0"
            )
            Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            return peStream.ToArray()
        }

        /// Rows whose encoded form equals an earlier row of the same table.
        private func RepeatedRows(bytes[]uint8) List[string] {
            let repeats = List[string]()
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let reader = pe.GetMetadataReader()
            let seen = HashSet[string](StringComparer.Ordinal)
            for handle in reader.MemberReferences {
                let row = reader.GetMemberReference(handle)
                let key = "${row.Parent.Kind}:${MetadataTokens.GetRowNumber(row.Parent)}:${reader.GetString(row.Name)}:" +
                    Convert.ToHexString(reader.GetBlobBytes(row.Signature))
                if !seen.Add("M|" + key) {
                    repeats.Add("MemberRef " + reader.GetString(row.Name))
                }
            }
            for var rid = 1; rid <= reader.GetTableRowCount(TableIndex.TypeSpec); rid++ {
                let row = reader.GetTypeSpecification(MetadataTokens.TypeSpecificationHandle(rid))
                if !seen.Add("T|" + Convert.ToHexString(reader.GetBlobBytes(row.Signature))) {
                    repeats.Add("TypeSpec row $rid")
                }
            }
            for var rid = 1; rid <= reader.GetTableRowCount(TableIndex.MethodSpec); rid++ {
                let row = reader.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(rid))
                let key = "S|${row.Method.Kind}:${MetadataTokens.GetRowNumber(row.Method)}:" + Convert.ToHexString(
                    reader.GetBlobBytes(row.Signature)
                )
                if !seen.Add(key) {
                    repeats.Add("MethodSpec row $rid")
                }
            }
            return repeats
        }

        private func LocateRepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Issue5172MetadataRowDeduplicationTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
