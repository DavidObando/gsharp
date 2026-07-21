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
    public void ClrMethodGroup_NestedNamedDelegateSlot_VerifiesAndRunsBesideReturnIfLocal()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2672MethodGroup");
        Directory.CreateDirectory(directory);
        var fixturePath = Path.Combine(directory, "Issue2672Fixture.dll");
        var outputPath = Path.Combine(directory, "Issue2672MethodGroup.dll");
        EmitFixture(fixturePath);

        const string source = """
            package Issue2672
            import System
            import System.Threading
            import Issue2672Fixture

            class Forwarder {
                shared {
                    func Forward(sendOrPost ((object?) -> void, object?) -> void, action () -> void) {
                        Console.WriteLine(ContextFactory.Created)
                        sendOrPost((state object?) -> action(), nil)
                    }
                }
            }

            func ForwardPost(sync SynchronizationContext, action () -> void) {
                Forwarder.Forward(sync.Post, action)
            }

            func ForwardSend(sync SynchronizationContext, action () -> void) {
                Forwarder.Forward(sync.Send, action)
            }

            func Sibling(type_ Type, fullName bool) string? {
                let TypeName = func () string? {
                    return if fullName { type_.FullName } else { type_.Name }
                }
                return TypeName()
            }

            func Main() {
                let context = ImmediateSynchronizationContext()
                Forwarder.Forward(ContextFactory.Current.Post, () -> Console.WriteLine("post"))
                ForwardSend(context, () -> Console.WriteLine("send"))
                Console.WriteLine(Sibling(typeof(string), false))
            }
            """;

        Emit(source, outputPath, fixturePath);
        IlVerifier.Verify(outputPath, additionalReferences: new[] { fixturePath });
        Assert.Equal("1\npost\n1\nsend\nString\n", Run(outputPath, fixturePath));
    }

    [Fact]
    public void ClrMethodGroup_IncompatibleArity_RemainsRejected()
    {
        const string source = """
            package Issue2672
            import System.Threading

            func Bad(sync SynchronizationContext) {
                let callback (string) -> void = sync.Post
            }
            """;
        using var resolver = ReferenceResolver.WithReferences(Array.Empty<string>());
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2672Negative");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0218");
    }

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

            public sealed class ImmediateSynchronizationContext : System.Threading.SynchronizationContext
            {
                public override void Post(System.Threading.SendOrPostCallback callback, object? state)
                    => callback(state);

                public override void Send(System.Threading.SendOrPostCallback callback, object? state)
                    => callback(state);
            }

            public static class ContextFactory
            {
                public static int Created { get; private set; }

                public static System.Threading.SynchronizationContext Current
                {
                    get
                    {
                        Created++;
                        return new ImmediateSynchronizationContext();
                    }
                }
            }

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

    private static void Emit(string source, string outputPath, string fixturePath)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: Path.GetFileNameWithoutExtension(outputPath));
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string Run(string outputPath, string fixturePath)
    {
        var context = new AssemblyLoadContext(Path.GetFileNameWithoutExtension(outputPath), isCollectible: true);
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

            return output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            context.Unload();
        }
    }
}
