// <copyright file="Issue2299CrossContextWrapperTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2299 (follow-up to #2290): the cross-reference-context
/// <see cref="TypeSymbol"/> identity split — two independent
/// <see cref="ReferenceResolver"/> instances loading the SAME on-disk
/// assembly each mint their own <see cref="System.Reflection.MetadataLoadContext"/>,
/// so the SAME metadata type resolves to two non-reference-equal CLR
/// <see cref="Type"/> objects (and, in turn, two non-reference-equal
/// <see cref="ImportedTypeSymbol"/> wrappers) — also breaks one level down,
/// through any structural wrapper symbol (<see cref="SliceTypeSymbol"/>,
/// <see cref="NullableTypeSymbol"/>, <see cref="ArrayTypeSymbol"/>,
/// <see cref="MapTypeSymbol"/>, etc.) whose element is the split imported
/// type — e.g. two <c>[]Series</c> slices for the "same" <c>Series</c> are
/// themselves non-reference-equal AND were previously classified as
/// <see cref="Conversion.None"/>, because the #2290 fix in
/// <see cref="Conversion.Classify(TypeSymbol, TypeSymbol)"/> only special-cased
/// a DIRECT <see cref="ImportedTypeSymbol"/>/<see cref="StructSymbol"/> pair —
/// wrapper symbols were deliberately excluded (their own <c>ClrType</c> is
/// borrowed from the element, so comparing the WRAPPER's <c>ClrType</c>
/// would be wrong). <see cref="Conversion.Classify(TypeSymbol, TypeSymbol)"/>
/// now recurses into the wrapped element type(s) whenever both sides are the
/// SAME wrapper kind, reusing the direct check (and this same recursive
/// step) so nested wrappers unwind depth-first.
/// </summary>
public class Issue2299CrossContextWrapperTypeIdentityTests
{
    private const string PlainClassLibrarySource = """
        package A.B

        class Series {
        }
        """;

    private const string TwoTypesLibrarySource = """
        package A.B

        class Series {
        }

        class Chapter {
        }
        """;

    [Fact]
    public void TwoSeparateResolvers_SliceOfImportedType_ClassifiesAsIdentity()
    {
        var libraryPath = this.EmitLibrary(PlainClassLibrarySource, nameof(this.TwoSeparateResolvers_SliceOfImportedType_ClassifiesAsIdentity));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA));
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB));
        Assert.False(ReferenceEquals(seriesA, seriesB));
        Assert.True(ClrTypeUtilities.AreSame(seriesA, seriesB));

        var symbolA = ImportedTypeSymbol.Get(seriesA);
        var symbolB = ImportedTypeSymbol.Get(seriesB);
        Assert.False(ReferenceEquals(symbolA, symbolB));

        var sliceA = SliceTypeSymbol.Get(symbolA);
        var sliceB = SliceTypeSymbol.Get(symbolB);
        Assert.False(ReferenceEquals(sliceA, sliceB));

        var conversion = Conversion.Classify(sliceA, sliceB);
        Assert.True(conversion.Exists, "expected a conversion to exist for []Series slices resolved via two independent resolvers");
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same []Series");

        var reverse = Conversion.Classify(sliceB, sliceA);
        Assert.True(reverse.Exists);
        Assert.True(reverse.IsIdentity);
    }

    [Fact]
    public void TwoSeparateResolvers_NullableOfImportedType_ClassifiesAsIdentity()
    {
        var libraryPath = this.EmitLibrary(PlainClassLibrarySource, nameof(this.TwoSeparateResolvers_NullableOfImportedType_ClassifiesAsIdentity));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA));
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB));

        var symbolA = ImportedTypeSymbol.Get(seriesA);
        var symbolB = ImportedTypeSymbol.Get(seriesB);

        var nullableA = NullableTypeSymbol.Get(symbolA);
        var nullableB = NullableTypeSymbol.Get(symbolB);
        Assert.False(ReferenceEquals(nullableA, nullableB));

        var conversion = Conversion.Classify(nullableA, nullableB);
        Assert.True(conversion.Exists, "expected a conversion to exist for Series? resolved via two independent resolvers");
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same Series?");
    }

    [Fact]
    public void TwoSeparateResolvers_FixedArrayOfImportedType_RequiresMatchingLengthAndClassifiesAsIdentity()
    {
        var libraryPath = this.EmitLibrary(PlainClassLibrarySource, nameof(this.TwoSeparateResolvers_FixedArrayOfImportedType_RequiresMatchingLengthAndClassifiesAsIdentity));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA));
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB));

        var symbolA = ImportedTypeSymbol.Get(seriesA);
        var symbolB = ImportedTypeSymbol.Get(seriesB);

        var sameLengthA = ArrayTypeSymbol.Get(symbolA, 4);
        var sameLengthB = ArrayTypeSymbol.Get(symbolB, 4);
        var identity = Conversion.Classify(sameLengthA, sameLengthB);
        Assert.True(identity.Exists);
        Assert.True(identity.IsIdentity);

        var differentLengthB = ArrayTypeSymbol.Get(symbolB, 5);
        var mismatched = Conversion.Classify(sameLengthA, differentLengthB);
        Assert.False(mismatched.Exists && mismatched.IsIdentity, "arrays of differing fixed length must NOT classify as identity");
    }

    [Fact]
    public void TwoSeparateResolvers_MapOfImportedType_ClassifiesAsIdentity()
    {
        var libraryPath = this.EmitLibrary(PlainClassLibrarySource, nameof(this.TwoSeparateResolvers_MapOfImportedType_ClassifiesAsIdentity));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA));
        Assert.True(resolverB.TryResolveType("A.B.Series", out var seriesB));

        var symbolA = ImportedTypeSymbol.Get(seriesA);
        var symbolB = ImportedTypeSymbol.Get(seriesB);

        var mapA = MapTypeSymbol.Get(TypeSymbol.String, symbolA);
        var mapB = MapTypeSymbol.Get(TypeSymbol.String, symbolB);

        var conversion = Conversion.Classify(mapA, mapB);
        Assert.True(conversion.Exists, "expected a conversion to exist for map[string]Series resolved via two independent resolvers");
        Assert.True(conversion.IsIdentity, "expected an identity conversion for structurally-same map[string]Series");
    }

    [Fact]
    public void TwoSeparateResolvers_SlicesOfDifferentElementTypes_DoNotClassifyAsIdentity()
    {
        var libraryPath = this.EmitLibrary(TwoTypesLibrarySource, nameof(this.TwoSeparateResolvers_SlicesOfDifferentElementTypes_DoNotClassifyAsIdentity));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Series", out var seriesA));
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var chapterB));

        var symbolA = ImportedTypeSymbol.Get(seriesA);
        var symbolB = ImportedTypeSymbol.Get(chapterB);

        var sliceA = SliceTypeSymbol.Get(symbolA);
        var sliceB = SliceTypeSymbol.Get(symbolB);

        var conversion = Conversion.Classify(sliceA, sliceB);
        Assert.False(conversion.Exists && conversion.IsIdentity, "[]Series and []Chapter must NOT classify as identity even across independent resolvers");
    }

    [Fact]
    public void SingleResolver_ListOfImportedType_PassedAcrossImportedFunctionBoundary_EmitsCleanly()
    {
        var libraryPath = this.EmitLibrary(
            """
            package A.B
            import System.Collections.Generic

            class Series {
            }

            class Catalog {
                func GetAll() List[Series] -> List[Series]()

                func Add(items List[Series], s Series) {
                    items.Add(s)
                }
            }
            """,
            nameof(this.SingleResolver_ListOfImportedType_PassedAcrossImportedFunctionBoundary_EmitsCleanly));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import A.B
                import System.Collections.Generic

                func Run() {
                    let catalog = Catalog()
                    let all List[Series] = catalog.GetAll()
                    catalog.Add(all, Series())
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private string EmitLibrary(string source, string caseName)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2299", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib2299.dll");

        var library = new Compilation(SyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Lib2299");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
