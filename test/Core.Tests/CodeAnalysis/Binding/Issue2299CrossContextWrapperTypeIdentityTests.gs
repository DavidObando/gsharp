// <copyright file="Issue2299CrossContextWrapperTypeIdentityTests.cs" company="GSharp">
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

/// Issue #2299 (follow-up to #2290): the cross-reference-context
/// (cref:TypeSymbol) identity split — two independent
/// (cref:ReferenceResolver) instances loading the SAME on-disk
/// assembly each mint their own (cref:System.Reflection.MetadataLoadContext),
/// so the SAME metadata type resolves to two non-reference-equal CLR
/// (cref:Type) objects (and, in turn, two non-reference-equal
/// (cref:ImportedTypeSymbol) wrappers) — also breaks one level down,
/// through any structural wrapper symbol ((cref:SliceTypeSymbol),
/// (cref:NullableTypeSymbol), (cref:ArrayTypeSymbol),
/// (cref:MapTypeSymbol), etc.) whose element is the split imported
/// type — e.g. two `[]Series` slices for the "same" `Series` are
/// themselves non-reference-equal AND were previously classified as
/// (cref:Conversion.None), because the #2290 fix in
/// (cref:Conversion.Classify(TypeSymbol, TypeSymbol)) only special-cased
/// a DIRECT (cref:ImportedTypeSymbol)/(cref:StructSymbol) pair —
/// wrapper symbols were deliberately excluded (their own `ClrType` is
/// borrowed from the element, so comparing the WRAPPER's `ClrType`
/// would be wrong). (cref:Conversion.Classify(TypeSymbol, TypeSymbol))
/// now recurses into the wrapped element type(s) whenever both sides are the
/// SAME wrapper kind, reusing the direct check (and this same recursive
/// step) so nested wrappers unwind depth-first.
open class Issue2299CrossContextWrapperTypeIdentityTests {
    @Fact
    func TwoSeparateResolvers_SliceOfImportedType_ClassifiesAsIdentity() {
        let libraryPath = this.EmitLibrary(
            PlainClassLibrarySource,
            "TwoSeparateResolvers_SliceOfImportedType_ClassifiesAsIdentity"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA))
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB))
        Assert.False(object.ReferenceEquals(seriesA, seriesB))
        Assert.True(ClrTypeUtilities.AreSame(seriesA, seriesB))
        let symbolA = ImportedTypeSymbol.Get(seriesA)
        let symbolB = ImportedTypeSymbol.Get(seriesB)
        Assert.False(object.ReferenceEquals(symbolA, symbolB))
        let sliceA = SliceTypeSymbol.Get(symbolA)
        let sliceB = SliceTypeSymbol.Get(symbolB)
        Assert.False(object.ReferenceEquals(sliceA, sliceB))
        let conversion = Conversion.Classify(sliceA, sliceB)
        Assert.True(
            conversion.Exists,
            "expected a conversion to exist for []Series slices resolved via two independent resolvers"
        )
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same []Series")
        let reverse = Conversion.Classify(sliceB, sliceA)
        Assert.True(reverse.Exists)
        Assert.True(reverse.IsIdentity)
    }

    @Fact
    func TwoSeparateResolvers_NullableOfImportedType_ClassifiesAsIdentity() {
        let libraryPath = this.EmitLibrary(
            PlainClassLibrarySource,
            "TwoSeparateResolvers_NullableOfImportedType_ClassifiesAsIdentity"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA))
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB))
        let symbolA = ImportedTypeSymbol.Get(seriesA)
        let symbolB = ImportedTypeSymbol.Get(seriesB)
        let nullableA = NullableTypeSymbol.Get(symbolA)
        let nullableB = NullableTypeSymbol.Get(symbolB)
        Assert.False(object.ReferenceEquals(nullableA, nullableB))
        let conversion = Conversion.Classify(nullableA, nullableB)
        Assert.True(
            conversion.Exists,
            "expected a conversion to exist for Series? resolved via two independent resolvers"
        )
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same Series?")
    }

    @Fact
    func TwoSeparateResolvers_FixedArrayOfImportedType_RequiresMatchingLengthAndClassifiesAsIdentity() {
        let libraryPath = this.EmitLibrary(
            PlainClassLibrarySource,
            "TwoSeparateResolvers_FixedArrayOfImportedType_RequiresMatchingLengthAndClassifiesAsIdentity"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA))
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB))
        let symbolA = ImportedTypeSymbol.Get(seriesA)
        let symbolB = ImportedTypeSymbol.Get(seriesB)
        let sameLengthA = ArrayTypeSymbol.Get(symbolA, 4)
        let sameLengthB = ArrayTypeSymbol.Get(symbolB, 4)
        let identity = Conversion.Classify(sameLengthA, sameLengthB)
        Assert.True(identity.Exists)
        Assert.True(identity.IsIdentity)
        let differentLengthB = ArrayTypeSymbol.Get(symbolB, 5)
        let mismatched = Conversion.Classify(sameLengthA, differentLengthB)
        Assert.False(
            mismatched.Exists && mismatched.IsIdentity,
            "arrays of differing fixed length must NOT classify as identity"
        )
    }

    @Fact
    func TwoSeparateResolvers_MapOfImportedType_ClassifiesAsIdentity() {
        let libraryPath = this.EmitLibrary(
            PlainClassLibrarySource,
            "TwoSeparateResolvers_MapOfImportedType_ClassifiesAsIdentity"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA))
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB))
        let symbolA = ImportedTypeSymbol.Get(seriesA)
        let symbolB = ImportedTypeSymbol.Get(seriesB)
        let mapA = MapTypeSymbol.Get(TypeSymbol.String, symbolA)
        let mapB = MapTypeSymbol.Get(TypeSymbol.String, symbolB)
        let conversion = Conversion.Classify(mapA, mapB)
        Assert.True(
            conversion.Exists,
            "expected a conversion to exist for map[string]Series resolved via two independent resolvers"
        )
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same map[string]Series")
    }

    @Fact
    func TwoSeparateResolvers_SlicesOfDifferentElementTypes_DoNotClassifyAsIdentity() {
        let libraryPath = this.EmitLibrary(
            TwoTypesLibrarySource,
            "TwoSeparateResolvers_SlicesOfDifferentElementTypes_DoNotClassifyAsIdentity"
        )
        using let resolverA = ReferenceResolver.WithReferences([]string{libraryPath})
        using let resolverB = ReferenceResolver.WithReferences([]string{libraryPath})
        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA))
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var chapterB))
        let symbolA = ImportedTypeSymbol.Get(seriesA)
        let symbolB = ImportedTypeSymbol.Get(chapterB)
        let sliceA = SliceTypeSymbol.Get(symbolA)
        let sliceB = SliceTypeSymbol.Get(symbolB)
        let conversion = Conversion.Classify(sliceA, sliceB)
        Assert.False(
            conversion.Exists && conversion.IsIdentity,
            "[]Series and []Chapter must NOT classify as identity even across independent resolvers"
        )
    }

    @Fact
    func SingleResolver_ListOfImportedType_PassedAcrossImportedFunctionBoundary_EmitsCleanly() {
        let libraryPath = this.EmitLibrary(`package A.B
import System.Collections.Generic

class Series {
}

class Catalog {
    func GetAll() List[Series] -> List[Series]()

    func Add(items List[Series], s Series) {
        items.Add(s)
    }
}`, "SingleResolver_ListOfImportedType_PassedAcrossImportedFunctionBoundary_EmitsCleanly")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import A.B
import System.Collections.Generic

func Run() {
    let catalog = Catalog()
    let all List[Series] = catalog.GetAll()
    catalog.Add(all, Series())
}`)))
        using let peStream = MemoryStream()
        let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    private func EmitLibrary(source string, caseName string) string {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2299", caseName)
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Lib2299.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let peStream = File.Create(libraryPath)
        let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Lib2299")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        return libraryPath
    }

    shared {
        private const PlainClassLibrarySource string = `package A.B

class Series {
}`

        private const TwoTypesLibrarySource string = `package A.B

class Series {
}

class Chapter {
}`
    }
}
