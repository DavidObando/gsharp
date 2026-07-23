// <copyright file="Issue2782LambdaOverloadTargetEmitTests.cs" company="GSharp">
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

public class Issue2782LambdaOverloadTargetEmitTests
{
    [Fact]
    public void ExpressionBodiedTaskResults_PreserveExactReturnTypeAcrossCandidateOrder()
    {
        var libraryPath = EmitCSharpLibrary("Expression");
        var output = CompileAndRun(
            libraryPath,
            """
            package LambdaOverloadTargetExpression
            import System
            import System.Collections.Generic
            import System.Threading.Tasks
            import Fixture2782

            Api.Register((value string) -> Task.FromResult[object](value))
            ApiReverse.Register((value string) -> Task.FromResult[object](value))
            Api.Register((value string) -> Task.FromResult[List[string]](List[string]()))
            """,
            "Expression");

        Assert.Equal(
            """
            delegate:System.Threading.Tasks.Task`1[System.Object]
            reverse:System.Threading.Tasks.Task`1[System.Object]
            delegate:System.Threading.Tasks.Task`1[System.Collections.Generic.List`1[System.String]]

            """,
            output);
    }

    [Fact]
    public void AsyncLambda_PreservesExactTaskResult()
    {
        var libraryPath = EmitCSharpLibrary("Async");
        var output = CompileAndRun(
            libraryPath,
            """
            package LambdaOverloadTargetAsync
            import System
            import System.Threading.Tasks
            import Fixture2782

            Api.Register(async (value string) -> await Task.FromResult[object](value))
            """,
            "Async");

        Assert.Equal("delegate:System.Threading.Tasks.Task`1[System.Object]\n", output);
    }

    [Fact]
    public void ExpressionBodiedValueTaskResult_PreservesExactGenericResult()
    {
        var libraryPath = EmitCSharpLibrary("ValueTask");
        var output = CompileAndRun(
            libraryPath,
            """
            package LambdaOverloadTargetValueTask
            import System
            import System.Threading.Tasks
            import Fixture2782

            ValueApi.Register((value string) -> ValueTask.FromResult[object](value))
            """,
            "ValueTask");

        Assert.Equal("value:System.Threading.Tasks.ValueTask`1[System.Object]\n", output);
    }

    [Fact]
    public void DelegateOnlyControl_MatchesOverloadedReturnShape()
    {
        var libraryPath = EmitCSharpLibrary("Control");
        var output = CompileAndRun(
            libraryPath,
            """
            package LambdaOverloadTargetControl
            import System
            import System.Threading.Tasks
            import Fixture2782

            Api.Register((value string) -> Task.FromResult[object](value))
            DelegateOnly.Register((value string) -> Task.FromResult[object](value))
            """,
            "Control");

        Assert.Equal(
            """
            delegate:System.Threading.Tasks.Task`1[System.Object]
            only:System.Threading.Tasks.Task`1[System.Object]

            """,
            output);
    }

    [Fact]
    public void EquallyApplicableConcreteDelegates_RemainAmbiguous()
    {
        var libraryPath = EmitCSharpLibrary("Ambiguous");
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package LambdaOverloadTargetAmbiguous
                import System.Threading.Tasks
                import Fixture2782

                AmbiguousApi.Register((value string) -> Task.FromResult[object](value))
                """)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Consumer2782Ambiguous");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0160");
    }

    private static string EmitCSharpLibrary(string caseName)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Fixture2782.dll");
        const string source = """
            using System;
            using System.Threading.Tasks;
            namespace Fixture2782;
            public delegate Task RequestHandler(string value);
            public delegate ValueTask ValueRequestHandler(string value);
            public delegate Task<object> FirstHandler(string value);
            public delegate Task<object> SecondHandler(string value);
            public static class Api
            {
                public static void Register(RequestHandler handler) =>
                    Console.WriteLine("request:" + handler.Method.ReturnType);
                public static void Register(Delegate handler) =>
                    Console.WriteLine("delegate:" + handler.Method.ReturnType);
            }
            public static class ApiReverse
            {
                public static void Register(Delegate handler) =>
                    Console.WriteLine("reverse:" + handler.Method.ReturnType);
                public static void Register(RequestHandler handler) =>
                    Console.WriteLine("reverse-request:" + handler.Method.ReturnType);
            }
            public static class ValueApi
            {
                public static void Register(ValueRequestHandler handler) =>
                    Console.WriteLine("value-request:" + handler.Method.ReturnType);
                public static void Register(Delegate handler) =>
                    Console.WriteLine("value:" + handler.Method.ReturnType);
            }
            public static class DelegateOnly
            {
                public static void Register(Delegate handler) =>
                    Console.WriteLine("only:" + handler.Method.ReturnType);
            }
            public static class AmbiguousApi
            {
                public static void Register(FirstHandler handler) { }
                public static void Register(SecondHandler handler) { }
            }
            """;

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator) ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Fixture2782",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }

    private static string CompileAndRun(string libraryPath, string source, string caseName)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var outputDir = Path.GetDirectoryName(libraryPath)!;
        var assemblyName = "Consumer2782" + caseName;
        var consumerPath = Path.Combine(outputDir, assemblyName + ".dll");
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using (var stream = File.Create(consumerPath))
        {
            var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: assemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var context = new AssemblyLoadContext("Issue2782" + caseName, isCollectible: true);
        context.Resolving += (_, name) => name.Name == "Fixture2782"
            ? context.LoadFromAssemblyPath(libraryPath)
            : null;
        try
        {
            var assembly = context.LoadFromAssemblyPath(consumerPath);
            var output = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                var entry = assembly.EntryPoint!;
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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

    private static string LibraryDirectory()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Issue2782Emit");
        Directory.CreateDirectory(path);
        return path;
    }
}
