// <copyright file="Issue2290CrossAssemblyTypeIdentityTests.cs" company="GSharp">
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
/// Issue #2290: a referenced (cross-assembly) type can be independently
/// re-minted into two non-reference-equal <see cref="TypeSymbol"/> wrappers
/// for the SAME underlying CLR type — the confirmed mechanism is that a
/// <see cref="System.Reflection.MetadataLoadContext"/>-backed
/// <see cref="ReferenceResolver"/> does not canonicalize <see cref="Type"/>
/// identity ACROSS two separate resolver instances that both load the same
/// on-disk assembly (each gets its own <c>MetadataLoadContext</c>, so
/// <c>Assembly.GetType(name)</c> from each returns a distinct <see cref="Type"/>
/// object for "the same" metadata type — <c>ReferenceEquals</c> is
/// <see langword="false"/> even though <see cref="ClrTypeUtilities.AreSame"/>
/// is <see langword="true"/>). <see cref="ImportedTypeSymbol.Get(Type)"/>
/// caches by <see cref="Type"/> identity, so the two <c>Type</c> objects mint
/// two distinct, non-reference-equal <see cref="ImportedTypeSymbol"/>
/// instances. <see cref="Conversion.Classify(TypeSymbol, TypeSymbol)"/>
/// previously only special-cased an <see cref="ImportedTypeSymbol"/> ⇄
/// <see cref="StructSymbol"/> pair (issue #2263); it now treats ANY pairing of
/// the two symbol kinds that wrap a genuine referenced CLR type — including
/// two <see cref="ImportedTypeSymbol"/> instances, or two semantic-aggregate
/// <see cref="StructSymbol"/> instances — as an identity conversion whenever
/// their underlying <see cref="Type"/> is the same metadata type.
/// </summary>
public class Issue2290CrossAssemblyTypeIdentityTests
{
    private const string PlainClassLibrarySource = """
        package A.B

        class Chapter {
        }
        """;

    private const string DataClassLibrarySource = """
        package A.B

        data class Chapter(Title string)

        class Book {
            func GetChapter() Chapter -> Chapter("intro")
        }
        """;

    [Fact]
    public void TwoSeparateResolvers_SameDll_ResolvePlainClass_ToNonReferenceEqual_ButMetadataIdentical_Types()
    {
        var libraryPath = EmitLibrary(PlainClassLibrarySource, nameof(this.TwoSeparateResolvers_SameDll_ResolvePlainClass_ToNonReferenceEqual_ButMetadataIdentical_Types));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });

        Assert.True(resolverA.TryResolveType("A.B.Chapter", out var typeA));
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var typeB));

        // Confirms the mechanism: independent resolvers do not canonicalize
        // Type identity for the same underlying assembly.
        Assert.False(ReferenceEquals(typeA, typeB));
        Assert.True(ClrTypeUtilities.AreSame(typeA, typeB));

        var symbolA = ImportedTypeSymbol.Get(typeA);
        var symbolB = ImportedTypeSymbol.Get(typeB);
        Assert.False(ReferenceEquals(symbolA, symbolB));

        var conversion = Conversion.Classify(symbolA, symbolB);
        Assert.True(conversion.Exists);
        Assert.True(conversion.IsIdentity);

        var reverse = Conversion.Classify(symbolB, symbolA);
        Assert.True(reverse.Exists);
        Assert.True(reverse.IsIdentity);
    }

    [Fact]
    public void TwoSeparateResolvers_SameDll_ResolveDataClass_SemanticAggregates_AsIdentityConvertible()
    {
        var libraryPath = EmitLibrary(DataClassLibrarySource, nameof(this.TwoSeparateResolvers_SameDll_ResolveDataClass_SemanticAggregates_AsIdentityConvertible));

        using var resolverA = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolverA.CurrentAssemblyName = "Consumer";
        using var resolverB = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolverB.CurrentAssemblyName = "Consumer";

        Assert.True(resolverA.TryResolveType("A.B.Chapter", out var typeA));
        Assert.True(resolverB.TryResolveType("A.B.Chapter", out var typeB));
        Assert.False(ReferenceEquals(typeA, typeB));

        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(typeA, resolverA, out var aggregateA));
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(typeB, resolverB, out var aggregateB));
        Assert.False(ReferenceEquals(aggregateA, aggregateB));

        var conversion = Conversion.Classify(aggregateA, aggregateB);
        Assert.True(conversion.Exists);
        Assert.True(conversion.IsIdentity);
    }

    [Fact]
    public void Qualified_And_Imported_BareName_Chapter_Convert_BothDirections_Cleanly()
    {
        var libraryPath = EmitLibrary(PlainClassLibrarySource, nameof(this.Qualified_And_Imported_BareName_Chapter_Convert_BothDirections_Cleanly));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
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
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Qualified_And_Imported_BareName_DataClassChapter_Convert_BothDirections_Cleanly()
    {
        var libraryPath = EmitLibrary(DataClassLibrarySource, nameof(this.Qualified_And_Imported_BareName_DataClassChapter_Convert_BothDirections_Cleanly));

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import A.B

                func Take(c A.B.Chapter) { }

                func Run() {
                    let bareCh Chapter = Book().GetChapter()
                    Take(bareCh)
                    let qualCh A.B.Chapter = bareCh
                    let bareCh2 Chapter = qualCh
                    let copy = bareCh2 with { Title = "renamed" }
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitLibrary(string source, string caseName)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2290", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib2290.dll");

        var library = new Compilation(SyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Lib2290");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
