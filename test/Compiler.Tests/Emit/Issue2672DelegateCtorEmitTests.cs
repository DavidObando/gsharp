// <copyright file="Issue2672DelegateCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2672: nested named-delegate parameters retain their exact delegate ABI.</summary>
public sealed class Issue2672DelegateCtorEmitTests
{
    [Fact]
    public void ImportedExtension_AsyncLambdaWithNamedDelegateParameter_VerifiesAndRuns()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2672DelegateCtor");
        Directory.CreateDirectory(directory);
        var fixturePath = Path.Combine(directory, "Issue2672Fixture.dll");
        var outputPath = Path.Combine(directory, "Issue2672Consumer.dll");
        EmitFixture(fixturePath);

        const string source = """
            package Issue2672
            import System
            import System.Threading.Tasks
            import Issue2672Fixture

            func Main() {
                let host = Host()
                let result = host.Run(async (ctx Context, next async (Context) -> void) -> {
                    await next(ctx)
                    ctx.Hits = ctx.Hits + 1
                }).GetAwaiter().GetResult()
                Console.WriteLine(result)
            }
            """;

        using (var resolver = ReferenceResolver.WithReferences(new[] { fixturePath }))
        {
            var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
            using var stream = File.Create(outputPath);
            var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2672Consumer");
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(outputPath, additionalReferences: new[] { fixturePath });
        var context = new AssemblyLoadContext("Issue2672", isCollectible: true);
        try
        {
            context.Resolving += (_, name) =>
                name.Name == "Issue2672Fixture" ? context.LoadFromAssemblyPath(fixturePath) : null;
            var assembly = context.LoadFromAssemblyPath(outputPath);
            var previous = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(previous);
            }

            Assert.Equal("2\n", output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        finally
        {
            context.Unload();
        }
    }

    private static void EmitFixture(string path)
    {
        const string source = """
            using System;
            using System.Threading.Tasks;

            namespace Issue2672Fixture;

            public sealed class Context
            {
                public int Hits { get; set; }
            }

            public sealed class Host { }

            public delegate Task Next(Context context);

            public static class MiddlewareExtensions
            {
                public static async Task<int> Run(
                    this Host host,
                    Func<Context, Next, Task> middleware)
                {
                    var context = new Context();
                    await middleware(context, c =>
                    {
                        c.Hits++;
                        return Task.CompletedTask;
                    });
                    return context.Hits;
                }
            }
            """;
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2672Fixture",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
