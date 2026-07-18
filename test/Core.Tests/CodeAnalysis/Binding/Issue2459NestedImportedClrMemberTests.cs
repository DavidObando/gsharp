// <copyright file="Issue2459NestedImportedClrMemberTests.cs" company="GSharp">
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

public class Issue2459NestedImportedClrMemberTests
{
    [Fact]
    public void NestedImportedFieldAndProperty_ResolveLikeMethod()
    {
        var libraryPath = EmitCSharpLibrary(
            """
            namespace ReproLib;

            public sealed class A
            {
                public B Field = new();
                public B Property { get; } = new();
            }

            public sealed class B
            {
                public int Field = 1;
                public int Property { get; } = 2;
                public int Method() => 3;
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import ReproLib

                func Read() int32 {
                    let a = A()
                    return a.Field.Field + a.Property.Property + a.Field.Method()
                }
                """)));

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0158");
    }

    private static string EmitCSharpLibrary(string source)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2459");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "ReproLib.dll");

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));

        var compilation = CSharpCompilation.Create(
            "ReproLib",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
