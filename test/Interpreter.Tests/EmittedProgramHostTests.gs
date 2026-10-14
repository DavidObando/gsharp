// <copyright file="EmittedProgramHostTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Execution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.IO
import System.Reflection
import System.Threading
import Xunit

/// ADR-0156 Phase 1: unit coverage for (cref:EmittedProgramHost) — the
/// shared emit-to-memory execution host behind bare `gsc` and
/// `gsi <file>`. Pins the exit-code mapping, the unhandled-exception
/// protocol (including the CLR-host crash rendering), emit-failure reporting,
/// best-effort cancellation, reference-assembly resolution, and reclamation of
/// the collectible (cref:System.Runtime.Loader.AssemblyLoadContext).
@Collection("ConsoleIo")
open class EmittedProgramHostTests {
    @Fact
    func TopLevelIntegerReturn_BecomesExitCode() {
        let (result, stdout, _) = Run(`import System

Console.WriteLine("tls-11")
return 7`)
        Assert.True(result!!.Success)
        Assert.Null(result!!.UnhandledException)
        Assert.Equal(7, result!!.ExitCode)
        Assert.Equal("tls-11${Environment.NewLine}", stdout)
    }

    @Fact
    func UnsignedMainReturn_BecomesExitCode() {
        let (result, stdout, _) = Run(`import System

func Main() uint32 {
    Console.WriteLine("unsigned-22")
    return 9
}`)
        Assert.True(result!!.Success)
        Assert.Equal(9, result!!.ExitCode)
        Assert.Equal("unsigned-22${Environment.NewLine}", stdout)
    }

    @Fact
    func TopLevelAwaitFor_DrainsAsyncEnumerable_TotalBecomesExitCode() {
        // Issue #3214: the statement-level `await for` form makes the
        // synthesized entry point async (ADR-0066 D3); the #1904 kickoff
        // drive keeps the CLR entry signature synchronous, so the gsi
        // file-mode host runs it like any other program.
        let (result, stdout, _) = Run(`import System
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
return total`)
        Assert.True(result!!.Success)
        Assert.Null(result!!.UnhandledException)
        Assert.Equal(6, result!!.ExitCode)
        Assert.Equal("6${Environment.NewLine}", stdout)
    }

    @Fact
    func VoidProgram_ExitsZero() {
        let (result, stdout, _) = Run(`import System

Console.WriteLine("void-33")`)
        Assert.True(result!!.Success)
        Assert.Equal(0, result!!.ExitCode)
        Assert.Equal("void-33${Environment.NewLine}", stdout)
    }

    @Fact
    func UnhandledException_IsSurfacedUnwrappedWithClrHostRendering() {
        let (result, stdout, _) = Run(`import System

Console.WriteLine("before-44")
throw InvalidOperationException("boom-44")`)
        Assert.True(result!!.Success)
        Assert.Equal("before-44${Environment.NewLine}", stdout)
        let exception = Assert.IsType[InvalidOperationException](result!!.UnhandledException)
        Assert.Equal("boom-44", exception.Message)
        // The driver-facing rendering matches `dotnet exec` byte-for-byte:
        // the CLR prefix, the program's own frames, and no reflection-invoker
        // or host frames below them.
        let rendered = EmittedProgramHost.FormatUnhandledException(exception)
        Assert.StartsWith(
            "Unhandled exception. System.InvalidOperationException: boom-44",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("<Main>$$", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("MethodBaseInvoker", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("EmittedProgramHost", rendered, StringComparison.Ordinal)
    }

    @Fact
    func InvalidEntryPointReturnType_CrashesLikeClrHostWithoutRunning() {
        let (result, stdout, _) = Run(`import System

func Main() string {
    Console.WriteLine("must-not-run")
    return "invalid"
}`)
        Assert.True(result!!.Success)
        Assert.Equal(string.Empty, stdout)
        let exception = Assert.IsType[MethodAccessException](result!!.UnhandledException)
        Assert.Equal("Entry point must have a return type of void, integer, or unsigned integer.", exception.Message)
    }

    @Fact
    func EmitFailure_ReportsDiagnosticsWithoutRunning() {
        let (result, stdout, stderr) = Run(`import System

Console.WriteLine(undefinedSymbol)`)
        Assert.False(result!!.Success)
        Assert.Contains(result!!.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.Null(result!!.UnhandledException)
        Assert.Equal(string.Empty, stdout)
        Assert.Equal(string.Empty, stderr)
    }

    @Fact
    func PreCancelledToken_ThrowsBeforeTheProgramRuns() {
        using let cancellation = CancellationTokenSource()
        cancellation.Cancel()
        let compilation = Compile(`import System

Console.WriteLine("must-not-run")`)
        let (stdout, _) = CaptureConsole(
            () -> {
                Assert.ThrowsAny[OperationCanceledException](
                    func () object? {
                        return EmittedProgramHost.Run(compilation, referencePaths: nil, cancellation.Token)
                    }
                )
                return 0
            }
        )
        Assert.Equal(string.Empty, stdout)
    }

    @Fact
    func CollectibleLoadContext_IsReclaimedAfterRun() {
        let (result, stdout, _) = Run(`import System

Console.WriteLine("collect-55")`)
        Assert.True(result!!.Success)
        Assert.Equal("collect-55${Environment.NewLine}", stdout)
        Assert.NotNull(result!!.LoadContext)
        for var i = 0; result!!.LoadContext!!.IsAlive && i < 10; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        Assert.False(result!!.LoadContext!!.IsAlive, "Collectible AssemblyLoadContext was not reclaimed after the run.")
    }

    @Fact
    func UserReferenceAssembly_ResolvesAtCompileTimeAndRuntime() {
        const Source = `import System
import Gsharp.Extensions.Optional

let name string? = "ada"
let upper = name.Map(func(s string) string { return s.ToUpper() })
Console.WriteLine(upper ?? "<absent>")`
        let extensionsPath = Assembly.Load("Gsharp.Extensions").Location
        using let resolver = ReferenceResolver.WithReferences([]string{extensionsPath})
        let compilation = Compilation(resolver, SyntaxTree.Parse(Source))
        var result EmittedProgramResult? = nil
        let (stdout, _) = CaptureConsole(
            () -> {
                result = EmittedProgramHost.Run(compilation, []string{extensionsPath})
                return 0
            }
        )
        Assert.True(result!!.Success, string.Join("\n", result!!.Diagnostics))
        Assert.Null(result!!.UnhandledException)
        Assert.Equal(0, result!!.ExitCode)
        Assert.Equal("ADA${Environment.NewLine}", stdout)
    }

    shared {
        private func Compile(source string) Compilation -> Compilation(SyntaxTree.Parse(source))

        private func Run(source string)(Result EmittedProgramResult?, Stdout string, Stderr string) {
            let compilation = Compile(source)
            var result EmittedProgramResult? = nil
            let (stdout, stderr) = CaptureConsole(
                () -> {
                    result = EmittedProgramHost.Run(compilation)
                    return 0
                }
            )
            return (result, stdout, stderr)
        }

        private func CaptureConsole(action() -> int32)(Stdout string, Stderr string) {
            using let stdout = StringWriter{NewLine: Environment.NewLine}
            using let stderr = StringWriter{NewLine: Environment.NewLine}
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                action()
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (
                stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                stderr.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        }
    }
}
