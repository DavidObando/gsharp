// <copyright file="Issue2290CrossAssemblyTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

/// Issue #2290: a referenced (cross-assembly) type can be independently
/// re-minted into two non-reference-equal (cref:TypeSymbol) wrappers
/// for the SAME underlying CLR type — the confirmed mechanism is that a
/// (cref:System.Reflection.MetadataLoadContext)-backed
/// (cref:ReferenceResolver) does not canonicalize (cref:Type)
/// identity ACROSS two separate resolver instances that both load the same
/// on-disk assembly (each gets its own `MetadataLoadContext`, so
/// `Assembly.GetType(name)` from each returns a distinct (cref:Type)
/// object for "the same" metadata type — `ReferenceEquals` is
/// `false` even though (cref:ClrTypeUtilities.AreSame)
/// is `true`). (cref:ImportedTypeSymbol.Get(Type))
/// caches by (cref:Type) identity, so the two `Type` objects mint
/// two distinct, non-reference-equal (cref:ImportedTypeSymbol)
/// instances. (cref:Conversion.Classify(TypeSymbol, TypeSymbol))
/// previously only special-cased an (cref:ImportedTypeSymbol) ⇄
/// (cref:StructSymbol) pair (issue #2263); it now treats ANY pairing of
/// the two symbol kinds that wrap a genuine referenced CLR type — including
/// two (cref:ImportedTypeSymbol) instances, or two semantic-aggregate
/// (cref:StructSymbol) instances — as an identity conversion whenever
/// their underlying (cref:Type) is the same metadata type.
open class Issue2290CrossAssemblyTypeIdentityTests {
    @Fact
    func TwoSeparateResolvers_SameDll_ResolvePlainClass_ToNonReferenceEqual_ButMetadataIdentical_Types() {
        let libraryPath = EmitLibrary(
            PlainClassLibrarySource,
            "TwoSeparateResolvers_SameDll_ResolvePlainClass_ToNonReferenceEqual_ButMetadataIdentical_Types"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Chapter", out var typeA))
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var typeB))
        // Confirms the mechanism: independent resolvers do not canonicalize
        // Type identity for the same underlying assembly.
        Assert.False(object.ReferenceEquals(typeA, typeB))
        Assert.True(ClrTypeUtilities.AreSame(typeA, typeB))
        let symbolA = ImportedTypeSymbol.Get(typeA)
        let symbolB = ImportedTypeSymbol.Get(typeB)
        Assert.False(object.ReferenceEquals(symbolA, symbolB))
        let conversion = Conversion.Classify(symbolA, symbolB)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsIdentity)
        let reverse = Conversion.Classify(symbolB, symbolA)
        Assert.True(reverse.Exists)
        Assert.True(reverse.IsIdentity)
    }

    @Fact
    func TwoSeparateResolvers_SameDll_ResolveDataClass_SemanticAggregates_AsIdentityConvertible() {
        let libraryPath = EmitLibrary(
            DataClassLibrarySource,
            "TwoSeparateResolvers_SameDll_ResolveDataClass_SemanticAggregates_AsIdentityConvertible"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        resolverA.CurrentAssemblyName = "Consumer"
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        resolverB.CurrentAssemblyName = "Consumer"
        Assert.True(resolverA.TryResolveType("A.B.Chapter", out var typeA))
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var typeB))
        Assert.False(object.ReferenceEquals(typeA, typeB))
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(typeA, resolverA, out var aggregateA))
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(typeB, resolverB, out var aggregateB))
        Assert.False(object.ReferenceEquals(aggregateA, aggregateB))
        let conversion = Conversion.Classify(aggregateA, aggregateB)
        Assert.True(conversion.Exists)
        Assert.True(conversion.IsIdentity)
    }

    @Fact
    func Qualified_And_Imported_BareName_Chapter_Convert_BothDirections_Cleanly() {
        let libraryPath = EmitLibrary(
            PlainClassLibrarySource,
            "Qualified_And_Imported_BareName_Chapter_Convert_BothDirections_Cleanly"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import A.B

func Take(c A.B.Chapter) { }

func Run() {
    let bareCh Chapter = Book().GetChapter()
    Take(bareCh)
    let qualCh A.B.Chapter = bareCh
    let bareCh2 Chapter = qualCh
}

class Book {
    func GetChapter() Chapter -> Chapter()
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func Qualified_And_Imported_BareName_DataClassChapter_Convert_BothDirections_Cleanly() {
        let libraryPath = EmitLibrary(
            DataClassLibrarySource,
            "Qualified_And_Imported_BareName_DataClassChapter_Convert_BothDirections_Cleanly"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import A.B

func Take(c A.B.Chapter) { }

func Run() {
    let bareCh Chapter = Book().GetChapter()
    Take(bareCh)
    let qualCh A.B.Chapter = bareCh
    let bareCh2 Chapter = qualCh
    let copy = bareCh2 with { Title = "renamed" }
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private const PlainClassLibrarySource string = `package A.B

class Chapter {
}`

        private const DataClassLibrarySource string = `package A.B

data class Chapter(Title string)

class Book {
    func GetChapter() Chapter -> Chapter("intro")
}`

        private func EmitLibrary(source string, caseName string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2290", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib2290.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Lib2290")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
