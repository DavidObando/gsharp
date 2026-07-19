// <copyright file="Issue2410ImportedDelegateAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue2410ImportedDelegateAssignmentTests
{
    private static readonly string LibraryPath = EmitCSharpLibrary();

    [Fact]
    public void ImportedStaticDelegateFieldAndProperty_UntypedLambdas_Bind()
    {
        AssertNoErrors("""
            package App
            import Lib2410

            func Main() {
                Holder.StaticField = (x) -> x + 1
                Holder.StaticProperty = (x) -> x + 2
            }
            """);
    }

    [Fact]
    public void ImportedDelegateAssignment_SiblingMemberPaths_Bind()
    {
        AssertNoErrors("""
            package App
            import Lib2410

            func Same(h Holder) Holder -> h

            func Main() {
                let h = Holder()
                h.InstanceField = (x) -> x + 1
                Same(h).InstanceProperty = (x) -> x + 2
                GenericHolder[int32].StaticField = (x) -> x + 3
                GenericHolder[int32].StaticProperty = (x) -> x + 4
            }
            """);
    }

    [Fact]
    public void ImportedStaticDelegateField_TypedLambda_StillBinds()
    {
        AssertNoErrors("""
            package App
            import Lib2410

            func Main() {
                Holder.StaticField = (x int32) -> x + 1
            }
            """);
    }

    [Fact]
    public void ImportedStaticDelegateField_ArityMismatch_RemainsRejected()
    {
        var diagnostics = Bind("""
            package App
            import Lib2410

            func Main() {
                Holder.StaticField = (x, y) -> x
            }
            """);

        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void ImportedStaticDelegateProperty_ReturnMismatch_RemainsRejected()
    {
        var diagnostics = Bind("""
            package App
            import Lib2410

            func Main() {
                Holder.StaticProperty = (x) -> "wrong"
            }
            """);

        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void ImportedStaticNonDelegateField_UntypedLambda_RemainsRejected()
    {
        var diagnostics = Bind("""
            package App
            import Lib2410

            func Main() {
                Holder.Number = (x) -> x
            }
            """);

        Assert.Contains(diagnostics, d => d.IsError);
    }

    private static void AssertNoErrors(string source)
    {
        Assert.DoesNotContain(Bind(source), d => d.IsError);
    }

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { LibraryPath });
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(resolver, tree);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }

    private static string EmitCSharpLibrary()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2410Binding");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib2410.dll");

        const string source = """
            namespace Lib2410
            {
                public delegate int Mapper(int value);

                public sealed class Holder
                {
                    public static Mapper StaticField;
                    public static Mapper StaticProperty { get; set; }
                    public static int Number;
                    public Mapper InstanceField;
                    public Mapper InstanceProperty { get; set; }
                }

                public sealed class GenericHolder<T>
                {
                    public static Mapper StaticField;
                    public static Mapper StaticProperty { get; set; }
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Lib2410",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
