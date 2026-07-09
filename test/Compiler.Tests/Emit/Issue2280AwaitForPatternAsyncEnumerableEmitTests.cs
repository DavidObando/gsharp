// <copyright file="Issue2280AwaitForPatternAsyncEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2280: <c>await for x in stream.ConfigureAwait(false) { ... }</c>
/// failed to bind with GS0134 because
/// <c>System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable&lt;T&gt;</c>
/// (returned by <c>IAsyncEnumerable&lt;T&gt;.ConfigureAwait(bool)</c>) implements
/// no interfaces at all — it is a fully duck-typed (pattern-based) async
/// enumerable per the C# <c>await foreach</c> spec: a parameterless
/// <c>GetAsyncEnumerator()</c> whose enumerator exposes <c>Current</c> and
/// <c>MoveNextAsync() -&gt; ConfiguredValueTaskAwaitable&lt;bool&gt;</c> (not
/// <c>ValueTask&lt;bool&gt;</c>), and disposes via a pattern
/// <c>DisposeAsync() -&gt; ConfiguredValueTaskAwaitable</c> (not
/// <c>IAsyncDisposable</c>).
/// <para>
/// These end-to-end tests pin the fix at runtime for: (1) the exact issue
/// repro (<c>.ConfigureAwait(false)</c> on an <c>IAsyncEnumerable[T]</c>), (2)
/// a fully hand-rolled duck-typed async enumerable with no interfaces
/// anywhere in its shape, proving the fix generalizes beyond
/// <c>ConfiguredCancelableAsyncEnumerable[T]</c> to the full C# pattern, and
/// (3) a regression guard for the pre-existing plain
/// <c>IAsyncEnumerable[T]</c> interface path.
/// </para>
/// </summary>
public class Issue2280AwaitForPatternAsyncEnumerableEmitTests
{
    #region Exact issue repro: IAsyncEnumerable[T].ConfigureAwait(false)

    [Fact]
    public void AwaitFor_ConfigureAwaitFalse_On_IAsyncEnumerable_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Numbers() IAsyncEnumerable[int32] {
                yield 1
                await Task.Yield()
                yield 2
            }

            async func Run() {
                var sum = 0
                await for n in Numbers().ConfigureAwait(false) {
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("3", stdout.Trim());
    }

    [Fact]
    public void AwaitFor_ConfigureAwaitFalse_Break_Disposes_Enumerator()
    {
        // Early `break` must still route through the pattern-based
        // DisposeAsync() (a ConfiguredValueTaskAwaitable, not IAsyncDisposable).
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Numbers() IAsyncEnumerable[int32] {
                yield 1
                await Task.Yield()
                yield 2
                await Task.Yield()
                yield 3
            }

            async func Run() {
                var sum = 0
                await for n in Numbers().ConfigureAwait(false) {
                    sum = sum + n
                    if n == 2 {
                        break
                    }
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("3", stdout.Trim());
    }

    #endregion

    #region Regression: plain IAsyncEnumerable[T] (no ConfigureAwait) still works

    [Fact]
    public void AwaitFor_PlainIAsyncEnumerable_Regression_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Numbers() IAsyncEnumerable[int32] {
                yield 1
                await Task.Yield()
                yield 2
            }

            async func Run() {
                var sum = 0
                await for n in Numbers() {
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("3", stdout.Trim());
    }

    #endregion

    #region Fully hand-rolled duck-typed async enumerable (no interfaces anywhere)

    [Fact]
    public void AwaitFor_FullyDuckTypedCustomAsyncEnumerable_Compiles_And_Runs()
    {
        // A custom C# helper library whose entire await-foreach surface —
        // the enumerable's GetAsyncEnumerator(), the enumerator's
        // MoveNextAsync()/Current/DisposeAsync(), and the awaitables
        // MoveNextAsync()/DisposeAsync() return — implements NO interfaces
        // except the minimal INotifyCompletion the C# awaiter pattern itself
        // requires. This proves the fix is the general pattern-based
        // `await foreach` shape, not a ConfiguredCancelableAsyncEnumerable[T]
        // special case.
        var helperLibPath = BuildCustomDuckTypedAsyncEnumerableLibrary();

        var source = """
            package Probe
            import System
            import CustomAsyncDuck

            async func Run() {
                var sum = 0
                var stream = Factory.Create()
                await for n in stream {
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source, extraReferences: new[] { helperLibPath });
        Assert.Equal("6", stdout.Trim());
    }

    private static string BuildCustomDuckTypedAsyncEnumerableLibrary()
    {
        const string HelperSource = """
            using System;
            using System.Runtime.CompilerServices;

            namespace CustomAsyncDuck
            {
                public struct MoveNextAwaiter : ICriticalNotifyCompletion
                {
                    private readonly bool result;

                    public MoveNextAwaiter(bool result) => this.result = result;

                    public bool IsCompleted => true;

                    public bool GetResult() => this.result;

                    public void OnCompleted(Action continuation) => continuation();

                    public void UnsafeOnCompleted(Action continuation) => continuation();
                }

                public struct MoveNextAwaitable
                {
                    private readonly bool result;

                    public MoveNextAwaitable(bool result) => this.result = result;

                    public MoveNextAwaiter GetAwaiter() => new MoveNextAwaiter(this.result);
                }

                public struct DisposeAwaiter : ICriticalNotifyCompletion
                {
                    public bool IsCompleted => true;

                    public void GetResult()
                    {
                    }

                    public void OnCompleted(Action continuation) => continuation();

                    public void UnsafeOnCompleted(Action continuation) => continuation();
                }

                public struct DisposeAwaitable
                {
                    public DisposeAwaiter GetAwaiter() => new DisposeAwaiter();
                }

                // Implements NO interfaces at all (not IAsyncDisposable).
                public sealed class CustomAsyncEnumerator
                {
                    private readonly int[] items;
                    private int index = -1;
                    public bool Disposed;

                    public CustomAsyncEnumerator(int[] items) => this.items = items;

                    public int Current => this.items[this.index];

                    public MoveNextAwaitable MoveNextAsync()
                    {
                        this.index++;
                        return new MoveNextAwaitable(this.index < this.items.Length);
                    }

                    public DisposeAwaitable DisposeAsync()
                    {
                        this.Disposed = true;
                        return new DisposeAwaitable();
                    }
                }

                // Implements NO interfaces at all (not IAsyncEnumerable[T]).
                public sealed class CustomAsyncEnumerable
                {
                    private readonly int[] items;

                    public CustomAsyncEnumerable(int[] items) => this.items = items;

                    public CustomAsyncEnumerator GetAsyncEnumerator() => new CustomAsyncEnumerator(this.items);
                }

                public static class Factory
                {
                    public static CustomAsyncEnumerable Create() => new CustomAsyncEnumerable(new[] { 1, 2, 3 });
                }
            }
            """;

        var tree = CSharpSyntaxTree.ParseText(HelperSource, new CSharpParseOptions(LanguageVersion.Latest));
        var references = RuntimeReferencePaths()
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CustomAsyncDuck",
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var dir = Directory.CreateTempSubdirectory("gs_2280_helperlib_").FullName;
        var path = Path.Combine(dir, "CustomAsyncDuck.dll");

        using (var stream = File.Create(path))
        {
            var result = compilation.Emit(stream);
            if (!result.Success)
            {
                var diagnostics = string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select(d => d.ToString()));
                throw new InvalidOperationException($"Failed to compile helper library:\n{diagnostics}");
            }
        }

        return path;
    }

    private static IReadOnlyList<string> RuntimeReferencePaths()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty;
        return tpa
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
            .ToList();
    }

    #endregion

    #region Helpers

    private static (Assembly assembly, string stdout) CompileRunCapture(string source, string[] extraReferences = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2280_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };

        if (extraReferences != null)
        {
            foreach (var reference in extraReferences)
            {
                args.Add("/r:" + reference);
            }
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath, extraReferences);

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        if (extraReferences != null)
        {
            // The helper assembly isn't on the default load path, so resolve
            // it explicitly when the runtime probes for it while invoking
            // <Main>$.
            AppDomain.CurrentDomain.AssemblyResolve += (_, resolveArgs) =>
            {
                var name = new AssemblyName(resolveArgs.Name).Name;
                foreach (var reference in extraReferences)
                {
                    if (string.Equals(Path.GetFileNameWithoutExtension(reference), name, StringComparison.OrdinalIgnoreCase))
                    {
                        return Assembly.LoadFrom(reference);
                    }
                }

                return null;
            };
        }

        // Run the entry point and capture stdout
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        var captured = new StringWriter();
        var prevOut2 = Console.Out;
        Console.SetOut(captured);
        try
        {
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(prevOut2);
        }

        return (assembly, captured.ToString().Replace("\r\n", "\n"));
    }

    #endregion
}
