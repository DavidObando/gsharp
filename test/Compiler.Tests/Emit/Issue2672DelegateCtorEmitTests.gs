// <copyright file="Issue2672DelegateCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis.Symbols
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import System.Reflection

/// Issue #2672: nested named-delegate parameters retain their exact delegate ABI.
class Issue2672DelegateCtorEmitTests {
    @Fact
    func ClrMethodGroup_NestedNamedDelegateSlot_VerifiesAndRunsBesideReturnIfLocal() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2672MethodGroup")
        Directory.CreateDirectory(directory)
        let fixturePath = Path.Combine(directory, "Issue2672Fixture.dll")
        let outputPath = Path.Combine(directory, "Issue2672MethodGroup.dll")
        EmitFixture(fixturePath)
        const source = `package Issue2672
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
}`
        Emit(source, outputPath, fixturePath)
        IlVerifier.Verify(outputPath, additionalReferences: []string{fixturePath})
        Assert.Equal(
            "1${Environment.NewLine}post${Environment.NewLine}1${Environment.NewLine}send${Environment.NewLine}String${Environment.NewLine}",
            Run(outputPath, fixturePath)
        )
    }

    @Fact
    func ClrMethodGroup_IncompatibleArity_RemainsRejected() {
        const source = `package Issue2672
import System.Threading

func Bad(sync SynchronizationContext) {
    let callback (string) -> void = sync.Post
}`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2672Negative")
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0218"
        )
    }

    @Fact
    func ImportedExtension_AsyncLambdaWithNamedDelegateParameter_VerifiesAndRuns() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2672DelegateCtor")
        Directory.CreateDirectory(directory)
        let fixturePath = Path.Combine(directory, "Issue2672Fixture.dll")
        let outputPath = Path.Combine(directory, "Issue2672Consumer.dll")
        EmitFixture(fixturePath)
        const source = `package Issue2672
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
}`
        {
            using let resolver = ReferenceResolver.WithReferences([]string{fixturePath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2672Consumer")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(outputPath, additionalReferences: []string{fixturePath})
        let context = AssemblyLoadContext("Issue2672", isCollectible: true)
        try {
            context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Issue2672Fixture" {
                context.LoadFromAssemblyPath(fixturePath)
            } else {
                default(Assembly?)
            }
            let assembly = context.LoadFromAssemblyPath(outputPath)
            let previous = Console.Out
            using let output = StringWriter()
            Console.SetOut(output)
            try {
                assembly.EntryPoint!!.Invoke(nil, nil)
            } finally {
                Console.SetOut(previous)
            }
            Assert.Equal("2${Environment.NewLine}", output.ToString().ReplaceLineEndings(Environment.NewLine))
        } finally {
            context.Unload()
        }
    }

    shared {
        private func EmitFixture(path string) {
            const source = `using System;
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
}`
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue2672Fixture",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Emit(source string, outputPath string, fixturePath string) {
            using let resolver = ReferenceResolver.WithReferences([]string{fixturePath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(
                stream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: Path.GetFileNameWithoutExtension(outputPath)
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Run(outputPath string, fixturePath string) string {
            let context = AssemblyLoadContext(Path.GetFileNameWithoutExtension(outputPath), isCollectible: true)
            try {
                context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Issue2672Fixture" {
                    context.LoadFromAssemblyPath(fixturePath)
                } else {
                    default(Assembly?)
                }
                let assembly = context.LoadFromAssemblyPath(outputPath)
                let previous = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
                try {
                    assembly.EntryPoint!!.Invoke(nil, nil)
                } finally {
                    Console.SetOut(previous)
                }
                return output.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                context.Unload()
            }
        }
    }
}
