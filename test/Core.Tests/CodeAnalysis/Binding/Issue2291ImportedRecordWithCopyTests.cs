// <copyright file="Issue2291ImportedRecordWithCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2291: an externally-referenced assembly that is a genuine C#
/// <c>record</c>/<c>record struct</c> but was compiled by the C# compiler
/// (not gsc) never carries the <c>GSharp.TypeSemantics</c> assembly-metadata
/// marker gsc writes for its own data classes/structs. Without a fallback,
/// gsc cannot recognize the type as a data class, so <c>x with { ... }</c> /
/// <c>copy</c> on it fails GS0161 even though it is a real record.
/// <see cref="ImportedAssemblySemantics.TryDetectCSharpRecordSemantics"/> now
/// recognizes the compiler-emitted record SHAPE — <c>PrintMembers</c> plus a
/// copy constructor for both a <c>record class</c> and a <c>record struct</c>,
/// plus <c>&lt;Clone&gt;$</c>/<c>EqualityContract</c> additionally required
/// for a <c>record class</c> — as a fallback data-class marker, generalized to
/// both record kinds. A plain (non-record) imported class/struct still fails
/// GS0161 (negative control).
/// </summary>
public class Issue2291ImportedRecordWithCopyTests
{
    [Fact]
    public void Imported_CSharpRecordClass_With_Compiles()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_CSharpRecordClass_With_Compiles),
            "namespace Records { public record Person(string Name, int Age); }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Records

                func Run() int32 {
                    let p = Person("Ada", 30)
                    let p2 = p with { Age = 5 }
                    return p2.Age
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_CSharpRecordStruct_With_Compiles()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_CSharpRecordStruct_With_Compiles),
            "namespace Records { public record struct Point(int X, int Y); }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Records

                func Run() int32 {
                    let p = Point(1, 2)
                    let p2 = p with { X = 9 }
                    return p2.X + p2.Y
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_CSharpRecordClass_Copy_Compiles()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_CSharpRecordClass_Copy_Compiles),
            "namespace Records { public record Person(string Name, int Age); }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Records

                func Run() int32 {
                    let p = Person("Ada", 30)
                    let p2 = p.copy(Age: 5)
                    return p2.Age
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_CSharpRecordClass_FromStaticProperty_With_Compiles()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_CSharpRecordClass_FromStaticProperty_With_Compiles),
            """
            #nullable enable
            namespace Records
            {
                public record Person(string Name, int Age)
                {
                    public static Person Default => new("Ada", 30);
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Records

                func Run() int32 {
                    let p = Person.Default
                    let p2 = p with { Age = 5 }
                    return p2.Age
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void Imported_SealedCSharpRecord_QualifiedTypeClause_With_Runs()
    {
        var referencePath = EmitCSharpReferenceLibrary(
            nameof(this.Imported_SealedCSharpRecord_QualifiedTypeClause_With_Runs),
            """
            namespace Records
            {
                public sealed record Settings
                {
                    public string Label { get; init; } = "ready";
                    public int Retries { get; init; } = 3;
                }
            }
            """,
            out var libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { referencePath });
        resolver.CurrentAssemblyName = "Consumer";
        Assert.True(resolver.TryResolveType("Records.Settings", out var reflected));
        Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(reflected, out _));

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer

                func Change(value Records.Settings) Records.Settings ->
                    value with { Label = "copied", Retries = 8 }

                func Main() {
                    let original = Records.Settings()
                    let changed = Change(original)
                    Console.WriteLine(original.Label)
                    Console.WriteLine(original.Retries)
                    Console.WriteLine(changed.Label)
                    Console.WriteLine(changed.Retries)
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("Issue2551-QualifiedRecord", isCollectible: true);
        loadContext.Resolving += (context, name) =>
            string.Equals(name.Name, "CSharpLib2291", StringComparison.Ordinal)
                ? context.LoadFromAssemblyPath(libraryPath)
                : null;
        try
        {
            var assembly = loadContext.LoadFromStream(peStream);
            var stdout = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            Assert.Equal("ready\n3\ncopied\n8\n", captured.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void Imported_PlainCSharpClass_With_StillReportsGs0161()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_PlainCSharpClass_With_StillReportsGs0161),
            "namespace Records { public class PlainPerson { public string Name { get; set; } public int Age { get; set; } } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import Records

                func Run() int32 {
                    let p = PlainPerson()
                    let p2 = p with { Age = 5 }
                    return p2.Age
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0161");
    }

    private static string EmitCSharpLibrary(string caseName, string recordSource)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2291", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2291.dll");

        var compilation = CreateCSharpCompilation(recordSource);
        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }

    private static string EmitCSharpReferenceLibrary(string caseName, string recordSource, out string implementationPath)
    {
        implementationPath = EmitCSharpLibrary(caseName, recordSource);
        var referencePath = Path.Combine(Path.GetDirectoryName(implementationPath)!, "CSharpLib2291.ref.dll");
        var compilation = CreateCSharpCompilation(recordSource);
        using var peStream = File.Create(referencePath);
        var emitResult = compilation.Emit(
            peStream,
            options: new Microsoft.CodeAnalysis.Emit.EmitOptions(metadataOnly: true, includePrivateMembers: false));
        Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        return referencePath;
    }

    private static CSharpCompilation CreateCSharpCompilation(string recordSource)
    {
        var syntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(
            recordSource,
            new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        return CSharpCompilation.Create(
            "CSharpLib2291",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
    }
}
