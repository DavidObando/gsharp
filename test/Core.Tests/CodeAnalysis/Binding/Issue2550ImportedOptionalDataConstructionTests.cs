// <copyright file="Issue2550ImportedOptionalDataConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2550: optional primary-constructor values must survive assembly
/// boundaries so imported data classes and C# records can be constructed with
/// omitted arguments before participating in <c>with</c>/<c>copy</c>.
/// </summary>
public class Issue2550ImportedOptionalDataConstructionTests
{
    [Fact]
    public void Imported_GSharpDataClass_DefaultedConstruction_WithAndCopy_Run()
    {
        var libraryPath = EmitGSharpLibrary(
            nameof(this.Imported_GSharpDataClass_DefaultedConstruction_WithAndCopy_Run));

        var output = EmitAndRun(
            libraryPath,
            "Issue2550.GSharp",
            """
            package Runner
            import Models

            func Main() {
                let original = Settings()
                let partial = Settings(5)
                let explicit = Settings(6, "explicit")
                let changed = original with { Retries = 8 }
                let copied = original.copy(Label: "copied")
                Console.WriteLine(original.Retries)
                Console.WriteLine(original.Label)
                Console.WriteLine(partial.Retries)
                Console.WriteLine(partial.Label)
                Console.WriteLine(explicit.Retries)
                Console.WriteLine(explicit.Label)
                Console.WriteLine(changed.Retries)
                Console.WriteLine(changed.Label)
                Console.WriteLine(copied.Retries)
                Console.WriteLine(copied.Label)
            }
            """);

        Assert.Equal(
            new[] { "3", "ready", "5", "ready", "6", "explicit", "8", "ready", "3", "copied" },
            Lines(output));
    }

    [Fact]
    public void Imported_CSharpRecord_DefaultedConstruction_WithAndCopy_Run()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.Imported_CSharpRecord_DefaultedConstruction_WithAndCopy_Run));

        var output = EmitAndRun(
            libraryPath,
            "Issue2550.CSharp",
            """
            package Runner
            import Models

            func Main() {
                let original = Settings()
                let partial = Settings(5)
                let explicit = Settings(6, "explicit")
                let changed = original with { Retries = 8 }
                let copied = original.copy(Label: "copied")
                Console.WriteLine(original.Retries)
                Console.WriteLine(original.Label)
                Console.WriteLine(partial.Retries)
                Console.WriteLine(partial.Label)
                Console.WriteLine(explicit.Retries)
                Console.WriteLine(explicit.Label)
                Console.WriteLine(changed.Retries)
                Console.WriteLine(changed.Label)
                Console.WriteLine(copied.Retries)
                Console.WriteLine(copied.Label)
            }
            """);

        Assert.Equal(
            new[] { "3", "ready", "5", "ready", "6", "explicit", "8", "ready", "3", "copied" },
            Lines(output));
    }

    private static string EmitGSharpLibrary(string caseName)
    {
        var libraryPath = LibraryPath(caseName, "Models.dll");
        var library = new GsCompilation(
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Models

                data class Settings(Retries int32 = 3, Label string = "ready")
                """)))
        {
            IsLibrary = true,
        };

        using var stream = File.Create(libraryPath);
        var result = library.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Models");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static string EmitCSharpLibrary(string caseName)
    {
        var libraryPath = LibraryPath(caseName, "Models.dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Models",
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    """namespace Models; public record Settings(int Retries = 3, string Label = "ready");"""),
            },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static string EmitAndRun(string libraryPath, string assemblyName, string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = assemblyName;
        var consumer = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = consumer.Emit(stream, pdbStream: null, refStream: null, assemblyName: assemblyName);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        stream.Position = 0;
        var context = new AssemblyLoadContext(assemblyName, isCollectible: true);
        context.Resolving += (loadContext, name) =>
            string.Equals(name.Name, "Models", StringComparison.Ordinal)
                ? loadContext.LoadFromAssemblyPath(libraryPath)
                : null;
        try
        {
            var assembly = context.LoadFromStream(stream);
            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            context.Unload();
        }
    }

    private static string LibraryPath(string caseName, string fileName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2550", caseName);
        Directory.CreateDirectory(directory);
        return Path.Combine(directory, fileName);
    }

    private static string[] Lines(string output) =>
        output.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);
}
