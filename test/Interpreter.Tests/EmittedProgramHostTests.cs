// <copyright file="EmittedProgramHostTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Threading;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 1: unit coverage for <see cref="EmittedProgramHost"/> — the
/// shared emit-to-memory execution host behind bare <c>gsc</c> and
/// <c>gsi &lt;file&gt;</c>. Pins the exit-code mapping, the unhandled-exception
/// protocol (including the CLR-host crash rendering), emit-failure reporting,
/// best-effort cancellation, reference-assembly resolution, and reclamation of
/// the collectible <see cref="System.Runtime.Loader.AssemblyLoadContext"/>.
/// </summary>
[Collection("ConsoleIo")]
public class EmittedProgramHostTests
{
    [Fact]
    public void TopLevelIntegerReturn_BecomesExitCode()
    {
        var (result, stdout, _) = Run("""
            import System

            Console.WriteLine("tls-11")
            return 7
            """);

        Assert.True(result.Success);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.ExitCode);
        Assert.Equal($"tls-11{Environment.NewLine}", stdout);
    }

    [Fact]
    public void UnsignedMainReturn_BecomesExitCode()
    {
        var (result, stdout, _) = Run("""
            import System

            func Main() uint32 {
                Console.WriteLine("unsigned-22")
                return 9
            }
            """);

        Assert.True(result.Success);
        Assert.Equal(9, result.ExitCode);
        Assert.Equal($"unsigned-22{Environment.NewLine}", stdout);
    }

    [Fact]
    public void TopLevelAwaitFor_DrainsAsyncEnumerable_TotalBecomesExitCode()
    {
        // Issue #3214: the statement-level `await for` form makes the
        // synthesized entry point async (ADR-0066 D3); the #1904 kickoff
        // drive keeps the CLR entry signature synchronous, so the gsi
        // file-mode host runs it like any other program.
        var (result, stdout, _) = Run("""
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Counts() IAsyncEnumerable[int32] {
                yield 1
                await Task.Yield()
                yield 2
                await Task.Yield()
                yield 3
            }

            var total = 0
            await for v in Counts() {
                total = total + v
            }
            Console.WriteLine(total)
            return total
            """);

        Assert.True(result.Success);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.ExitCode);
        Assert.Equal($"6{Environment.NewLine}", stdout);
    }

    [Fact]
    public void VoidProgram_ExitsZero()
    {
        var (result, stdout, _) = Run("""
            import System

            Console.WriteLine("void-33")
            """);

        Assert.True(result.Success);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"void-33{Environment.NewLine}", stdout);
    }

    [Fact]
    public void UnhandledException_IsSurfacedUnwrappedWithClrHostRendering()
    {
        var (result, stdout, _) = Run("""
            import System

            Console.WriteLine("before-44")
            throw InvalidOperationException("boom-44")
            """);

        Assert.True(result.Success);
        Assert.Equal($"before-44{Environment.NewLine}", stdout);
        var exception = Assert.IsType<InvalidOperationException>(result.UnhandledException);
        Assert.Equal("boom-44", exception.Message);

        // The driver-facing rendering matches `dotnet exec` byte-for-byte:
        // the CLR prefix, the program's own frames, and no reflection-invoker
        // or host frames below them.
        var rendered = EmittedProgramHost.FormatUnhandledException(exception);
        Assert.StartsWith("Unhandled exception. System.InvalidOperationException: boom-44", rendered, StringComparison.Ordinal);
        Assert.Contains("<Main>$", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("MethodBaseInvoker", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("EmittedProgramHost", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void InvalidEntryPointReturnType_CrashesLikeClrHostWithoutRunning()
    {
        var (result, stdout, _) = Run("""
            import System

            func Main() string {
                Console.WriteLine("must-not-run")
                return "invalid"
            }
            """);

        Assert.True(result.Success);
        Assert.Equal(string.Empty, stdout);
        var exception = Assert.IsType<MethodAccessException>(result.UnhandledException);
        Assert.Equal(
            "Entry point must have a return type of void, integer, or unsigned integer.",
            exception.Message);
    }

    [Fact]
    public void EmitFailure_ReportsDiagnosticsWithoutRunning()
    {
        var (result, stdout, stderr) = Run("""
            import System

            Console.WriteLine(undefinedSymbol)
            """);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(string.Empty, stdout);
        Assert.Equal(string.Empty, stderr);
    }

    [Fact]
    public void PreCancelledToken_ThrowsBeforeTheProgramRuns()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        var compilation = Compile("""
            import System

            Console.WriteLine("must-not-run")
            """);

        var (stdout, _) = CaptureConsole(() =>
        {
            Assert.ThrowsAny<OperationCanceledException>(
                () => EmittedProgramHost.Run(compilation, referencePaths: null, cancellation.Token));
            return 0;
        });
        Assert.Equal(string.Empty, stdout);
    }

    [Fact]
    public void CollectibleLoadContext_IsReclaimedAfterRun()
    {
        var (result, stdout, _) = Run("""
            import System

            Console.WriteLine("collect-55")
            """);

        Assert.True(result.Success);
        Assert.Equal($"collect-55{Environment.NewLine}", stdout);
        Assert.NotNull(result.LoadContext);
        for (var i = 0; result.LoadContext.IsAlive && i < 10; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }

        Assert.False(result.LoadContext.IsAlive, "Collectible AssemblyLoadContext was not reclaimed after the run.");
    }

    [Fact]
    public void UserReferenceAssembly_ResolvesAtCompileTimeAndRuntime()
    {
        const string Source = """
            import System
            import Gsharp.Extensions.Optional

            let name string? = "ada"
            let upper = name.Map(func(s string) string { return s.ToUpper() })
            Console.WriteLine(upper ?? "<absent>")
            """;
        var extensionsPath = Assembly.Load("Gsharp.Extensions").Location;

        using var resolver = ReferenceResolver.WithReferences(new[] { extensionsPath });
        var compilation = new Compilation(resolver, SyntaxTree.Parse(Source));
        EmittedProgramResult result = null;
        var (stdout, _) = CaptureConsole(() =>
        {
            result = EmittedProgramHost.Run(compilation, new[] { extensionsPath });
            return 0;
        });

        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"ADA{Environment.NewLine}", stdout);
    }

    private static Compilation Compile(string source)
        => new(SyntaxTree.Parse(source));

    private static (EmittedProgramResult Result, string Stdout, string Stderr) Run(string source)
    {
        var compilation = Compile(source);
        EmittedProgramResult result = null;
        var (stdout, stderr) = CaptureConsole(() =>
        {
            result = EmittedProgramHost.Run(compilation);
            return 0;
        });
        return (result, stdout, stderr);
    }

    private static (string Stdout, string Stderr) CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter { NewLine = Environment.NewLine };
        using var stderr = new StringWriter { NewLine = Environment.NewLine };
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            action();
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (
            stdout.ToString().ReplaceLineEndings(Environment.NewLine),
            stderr.ToString().ReplaceLineEndings(Environment.NewLine));
    }
}
