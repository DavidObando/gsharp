// <copyright file="Issue2643NamedGenericDelegateArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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

namespace GSharp.Compiler.Tests.Emit;

public class Issue2643NamedGenericDelegateArgumentEmitTests
{
    [Fact]
    public void OahuConvertDelegateExactSites_RunAndVerify()
    {
        var output = CompileAndRun(
            """
            package App
            import System
            import Lib2643
            import Lib2643.Models

            class SimpleCancellation : ICancellation {
                let Name string
                init(name string) { this.Name = name }
            }

            class CliCancellation : ICancellation {
                let Name string
                init(name string) { this.Name = name }
            }

            func Main() {
                var mainWindowAction ((Book, SimpleCancellation, (Conversion) -> void) -> void)? = nil
                mainWindowAction = (book Book, ctx SimpleCancellation, callback (Conversion) -> void) -> {
                    callback(Conversion("${book.Name}:${ctx.Name}:window"))
                }

                var audibleAction ((Book, CliCancellation, (Conversion) -> void) -> void)? = nil
                audibleAction = (book Book, ctx CliCancellation, callback (Conversion) -> void) -> {
                    callback(Conversion("${book.Name}:${ctx.Name}:cli"))
                }

                let windowJob = DownloadDecryptJob[SimpleCancellation]()
                Console.WriteLine(windowJob.Run(SimpleCancellation("simple"), mainWindowAction!!))
                let cliJob = DownloadDecryptJob[CliCancellation]()
                Console.WriteLine(cliJob.Run(CliCancellation("linked"), audibleAction!!))
            }
            """,
            nameof(OahuConvertDelegateExactSites_RunAndVerify));

        Assert.Equal("book:simple:window\nbook:linked:cli\n", output);
    }

    [Fact]
    public void GenericMethod_InfersNamedDelegateTypeArgumentFromStructuralFunction_RunAndVerify()
    {
        var output = CompileAndRun(
            """
            package App
            import System
            import Lib2643
            import Lib2643.Models

            class SimpleCancellation : ICancellation {}

            func Main() {
                let convertAction (Book, SimpleCancellation, (Conversion) -> void) -> void =
                    (book Book, ctx SimpleCancellation, callback (Conversion) -> void) -> {}
                Console.WriteLine(GenericRunner.Infer(convertAction))
            }
            """,
            nameof(GenericMethod_InfersNamedDelegateTypeArgumentFromStructuralFunction_RunAndVerify));

        Assert.Equal("SimpleCancellation\n", output);
    }

    [Fact]
    public void NamedDelegateValue_PreservesIdentityAcrossGenericCall_RunAndVerify()
    {
        var output = CompileAndRun(
            """
            package App
            import System
            import Lib2643

            class SimpleCancellation : ICancellation {}

            func Main() {
                let action = GenericRunner.Create[SimpleCancellation]()
                Console.WriteLine(GenericRunner.IsSame(action, action))
            }
            """,
            nameof(NamedDelegateValue_PreservesIdentityAcrossGenericCall_RunAndVerify));

        Assert.Equal("True\n", output);
    }

    [Fact]
    public void StructurallyIncompatibleFunction_StillRejected()
    {
        var libraries = EmitCSharpLibraries(nameof(StructurallyIncompatibleFunction_StillRejected));
        using var resolver = ReferenceResolver.WithReferences(new[] { libraries.ModelsPath, libraries.LibraryPath });
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package App
                import Lib2643
                import Lib2643.Models

                class SimpleCancellation : ICancellation {}

                func Main() {
                    let bad (Book, SimpleCancellation, (int32) -> void) -> void =
                        (book Book, ctx SimpleCancellation, callback (int32) -> void) -> {}
                    let job = DownloadDecryptJob[SimpleCancellation]()
                    job.Run(SimpleCancellation("simple"), bad)
                }
                """)));

        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2643.Negative");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0159");
    }

    private static string CompileAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2643Emit", caseName);
        Directory.CreateDirectory(directory);
        var libraries = EmitCSharpLibraries(caseName);
        var consumerPath = Path.Combine(directory, "Consumer.dll");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraries.ModelsPath, libraries.LibraryPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using (var stream = File.Create(consumerPath))
        {
            var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2643." + caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraries.ModelsPath, libraries.LibraryPath });

        var context = new AssemblyLoadContext("Issue2643." + caseName, isCollectible: true);
        try
        {
            context.Resolving += (_, name) => name.Name switch
            {
                "Lib2643" => context.LoadFromAssemblyPath(libraries.LibraryPath),
                "Lib2643.Models" => context.LoadFromAssemblyPath(libraries.ModelsPath),
                _ => null,
            };
            var assembly = context.LoadFromAssemblyPath(consumerPath);
            var output = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(output);
            }

            return captured.ToString().Replace("\r\n", "\n");
        }
        finally
        {
            context.Unload();
        }
    }

    private static (string LibraryPath, string ModelsPath) EmitCSharpLibraries(string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2643Emit", caseName);
        Directory.CreateDirectory(directory);
        var modelsPath = Path.Combine(directory, "Lib2643.Models.dll");
        var libraryPath = Path.Combine(directory, "Lib2643.dll");
        const string modelsSource = """
            namespace Lib2643.Models
            {
                public sealed class Book
                {
                    public Book(string name) => Name = name;
                    public string Name { get; }
                }
                public sealed class Conversion
                {
                    public Conversion(string value) => Value = value;
                    public string Value { get; }
                }
            }
            """;
        const string source = """
            using System;
            using Lib2643.Models;

            namespace Lib2643
            {
                public interface ICancellation { }
                public delegate void ConvertDelegate<T>(
                    Book book,
                    T context,
                    Action<Conversion> callback)
                    where T : ICancellation;

                public sealed class DownloadDecryptJob<T> where T : ICancellation
                {
                    public string Run(T context, ConvertDelegate<T> convertAction)
                    {
                        string result = null;
                        convertAction(new Book("book"), context, conversion => result = conversion.Value);
                        return result;
                    }
                }

                public static class GenericRunner
                {
                    public static string Infer<T>(ConvertDelegate<T> action) where T : ICancellation => typeof(T).Name;

                    public static ConvertDelegate<T> Create<T>() where T : ICancellation => (_, _, _) => { };

                    public static bool IsSame<T>(ConvertDelegate<T> expected, ConvertDelegate<T> actual)
                        where T : ICancellation
                        => ReferenceEquals(expected, actual);
                }
            }
            """;

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToArray();
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary);
        var modelsCompilation = CSharpCompilation.Create(
            "Lib2643.Models",
            new[] { CSharpSyntaxTree.ParseText(modelsSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            options);
        using (var stream = File.Create(modelsPath))
        {
            var result = modelsCompilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        var compilation = CSharpCompilation.Create(
            "Lib2643",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references.Append(MetadataReference.CreateFromFile(modelsPath)),
            options);

        using var libraryStream = File.Create(libraryPath);
        var libraryResult = compilation.Emit(libraryStream);
        Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics));
        return (libraryPath, modelsPath);
    }
}
