// <copyright file="Issue2531ImportedPropertyHidingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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

public sealed class Issue2531ImportedPropertyHidingTests
{
    [Fact]
    public void CSharpProducer_DerivedSameNamedProperties_ReadAndWrite()
    {
        var libraryPath = EmitCSharpLibrary();
        AssertConsumerCompiles(libraryPath, "CSharpProducer");
    }

    [Fact]
    public void GSharpProducer_DerivedSameNamedProperties_ReadAndWrite()
    {
        var libraryPath = EmitGSharpLibrary();
        AssertConsumerCompiles(libraryPath, "GSharpProducer");
    }

    private static void AssertConsumerCompiles(string libraryPath, string producerNamespace)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                $$"""
                package Consumer
                import System
                import {{producerNamespace}}

                func Read(c C) {
                    c.P = "derived"
                    let derivedValue string = c.P
                    c.Q = 2
                    let sameTypeValue int32 = c.Q

                    let a A = c
                    a.P = Object()
                    let baseValue object = a.P
                }
                """)));

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitCSharpLibrary()
    {
        const string source = """
            #nullable enable

            namespace CSharpProducer;

            public class A
            {
                public object P { get; set; } = new();
                public int Q { get; set; }
            }

            public class B : A
            {
                public new string P { get; set; } = "";
                public new int Q { get; set; }
            }

            public sealed class C : B;
            """;

        var outputPath = GetOutputPath("CSharpProducer.dll");
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "CSharpProducer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string EmitGSharpLibrary()
    {
        const string source = """
            package GSharpProducer

            open class A {
                prop P object { get; set; }
                prop Q int32 { get; set; }
            }

            open class B : A {
                prop P string { get; set; }
                prop Q int32 { get; set; }
            }

            class C : B {
            }
            """;

        var outputPath = GetOutputPath("GSharpProducer.dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "GSharpProducer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string GetOutputPath(string fileName)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2531ImportedPropertyHidingTests));
        Directory.CreateDirectory(outputDirectory);
        return Path.Combine(outputDirectory, fileName);
    }
}
