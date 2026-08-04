// <copyright file="Issue3006FallthroughGuardDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3006: every user-function invocation path must surface the non-void
/// fallthrough guard instead of returning <c>default(T)</c>.
/// </summary>
public class Issue3006FallthroughGuardDriverTests
{
    private const string GuardMessage = DiagnosticDescriptors.NonVoidFallthroughGuardMessage;

    public static IEnumerable<object[]> FallthroughCases()
    {
        yield return Case("DirectFunction", """
            import System

            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            Console.WriteLine(F(DateTimeKind(99)))
            """);

        yield return Case("EntryPoint", """
            import System

            func Main() int32 {
                let x = DateTimeKind(99)
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }
            """);

        yield return Case("NestedFunctionCall", """
            import System

            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            func Invoke() int32 {
                return F(DateTimeKind(99))
            }

            Console.WriteLine(Invoke())
            """);

        yield return Case("FixedArm", """
            import System

            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        unsafe {
                            fixed p *int32 = values {
                                return *p
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            Console.WriteLine(F(DateTimeKind(99), []int32{11}))
            """);

        yield return Case("ProtectedFinally", """
            import System

            func F(x DateTimeKind) int32 {
                try {
                    switch x {
                        case DateTimeKind.Unspecified { return 11 }
                        case DateTimeKind.Utc { return 22 }
                        case DateTimeKind.Local { return 33 }
                    }
                } finally {
                }
            }

            Console.WriteLine(F(DateTimeKind(99)))
            """);

        yield return Case("LambdaInvoke", """
            import System

            let f = func(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            Console.WriteLine(f(DateTimeKind(99)))
            """);

        yield return Case("InstanceMethod", """
            import System

            class C {
                func F(x DateTimeKind) int32 {
                    switch x {
                        case DateTimeKind.Unspecified { return 11 }
                        case DateTimeKind.Utc { return 22 }
                        case DateTimeKind.Local { return 33 }
                    }
                }
            }

            Console.WriteLine(C().F(DateTimeKind(99)))
            """);

        yield return Case("PropertyGetter", """
            import System

            class C {
                prop Kind DateTimeKind
                prop Value int32 {
                    get {
                        switch this.Kind {
                            case DateTimeKind.Unspecified { return 11 }
                            case DateTimeKind.Utc { return 22 }
                            case DateTimeKind.Local { return 33 }
                        }
                    }
                }
            }

            let c = C{}
            c.Kind = DateTimeKind(99)
            Console.WriteLine(c.Value)
            """);

        yield return Case("StaticPropertyGetter", """
            import System

            class C {
                shared {
                    prop Kind DateTimeKind -> DateTimeKind(99)
                    prop Value int32 {
                        get {
                            switch Kind {
                                case DateTimeKind.Unspecified { return 11 }
                                case DateTimeKind.Utc { return 22 }
                                case DateTimeKind.Local { return 33 }
                            }
                        }
                    }
                }
            }

            Console.WriteLine(C.Value)
            """);

        yield return Case("IndexerGetter", """
            import System

            class C {
                prop this[x DateTimeKind] int32 {
                    get {
                        switch x {
                            case DateTimeKind.Unspecified { return 11 }
                            case DateTimeKind.Utc { return 22 }
                            case DateTimeKind.Local { return 33 }
                        }
                    }
                }
            }

            Console.WriteLine(C{}[DateTimeKind(99)])
            """);

        yield return Case("UserOperator", """
            import System

            struct Choice {
                var Kind DateTimeKind
            }

            func (left Choice) operator +(right Choice) int32 {
                switch left.Kind {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            Console.WriteLine(Choice{Kind: DateTimeKind(99)} + Choice{})
            """);

        yield return Case("LiftedNullableOperator", """
            import System

            struct Choice(Kind DateTimeKind) {
            }

            func (left Choice) operator +(right Choice) int32 {
                switch left.Kind {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            let left Choice? = Choice(DateTimeKind(99))
            let right Choice? = Choice(DateTimeKind.Utc)
            Console.WriteLine((left + right)!!)
            """);
    }

    [Theory]
    [MemberData(nameof(FallthroughCases))]
    public async Task UnmatchedExhaustiveSwitch_AllDriversSurfaceGuard(string name, string source)
    {
        // ADR-0156 Phase 1: every driver executes emitted code, so all three
        // surface the guard identically — the InvalidOperationException crash
        // protocol of the CLR host, not an interpreter diagnostic.
        var root = CreateEmptyProbeRoot(name);
        try
        {
            var compilerEvaluation = RunSourceDriver(
                CreateEmptyDirectory(root, "gsc-eval"),
                source,
                Program.Main);
            Assert.Equal(ExpectedUnhandledExceptionExitCode, compilerEvaluation.ExitCode);
            Assert.Equal(string.Empty, compilerEvaluation.StandardOutput);
            Assert.Contains($"Unhandled exception. System.InvalidOperationException: {GuardMessage}", compilerEvaluation.StandardError);

            var interpreter = RunSourceDriver(
                CreateEmptyDirectory(root, "gsi"),
                source,
                GSharp.Repl.Program.Main);
            Assert.Equal(ExpectedUnhandledExceptionExitCode, interpreter.ExitCode);
            Assert.Equal(string.Empty, interpreter.StandardOutput);
            Assert.Contains($"Unhandled exception. System.InvalidOperationException: {GuardMessage}", interpreter.StandardError);

            var emitted = await CompileAndRunAsync(
                CreateEmptyDirectory(root, "gsc-emit"),
                source);
            Assert.Equal(0, emitted.Compile.ExitCode);
            Assert.Equal(string.Empty, emitted.Compile.StandardError);
            Assert.Equal(ExpectedUnhandledExceptionExitCode, emitted.Execution.ExitCode);
            Assert.Equal(string.Empty, emitted.Execution.StandardOutput);
            Assert.Contains($"System.InvalidOperationException: {GuardMessage}", emitted.Execution.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ExhaustiveControlFlow_AllDriversReturnDistinctValues()
    {
        const string Source = """
            import System

            enum E { A, B, C }

            func EnumSwitch(x E) int32 {
                switch x {
                    case E.A { return 11 }
                    case E.B { return 22 }
                    case E.C { return 33 }
                }
            }

            func IntSwitch(x int32) int32 {
                switch x {
                    case 1 { return 44 }
                    default { return 55 }
                }
            }

            func StringIf(x string) int32 {
                if x == "first" {
                    return 66
                } else {
                    return 77
                }
            }

            func ProtectedReturn() int32 {
                try {
                    return 88
                } finally {
                }
            }

            func Generic[T any](value T) T {
                return value
            }

            func ExpressionSwitch(x E) int32 {
                return switch x {
                    case E.A: 111
                    case E.B: 222
                    case E.C: 333
                }
            }

            func InfiniteLoop() int32 {
                for {
                }
            }

            Console.WriteLine(EnumSwitch(E.B))
            Console.WriteLine(IntSwitch(9))
            Console.WriteLine(StringIf("other"))
            Console.WriteLine(ProtectedReturn())
            Console.WriteLine(Generic("generic"))
            Console.WriteLine(ExpressionSwitch(E.C))
            """;
        var expected = $"22{Environment.NewLine}"
            + $"55{Environment.NewLine}"
            + $"77{Environment.NewLine}"
            + $"88{Environment.NewLine}"
            + $"generic{Environment.NewLine}"
            + $"333{Environment.NewLine}";
        var root = CreateEmptyProbeRoot("Valid");

        try
        {
            var compilerEvaluation = RunSourceDriver(
                CreateEmptyDirectory(root, "gsc-eval"),
                Source,
                Program.Main);
            Assert.Equal(0, compilerEvaluation.ExitCode);
            Assert.Equal(expected + $"Success.{Environment.NewLine}", compilerEvaluation.StandardOutput);
            Assert.Equal(string.Empty, compilerEvaluation.StandardError);

            var interpreter = RunSourceDriver(
                CreateEmptyDirectory(root, "gsi"),
                Source,
                GSharp.Repl.Program.Main);
            Assert.Equal(0, interpreter.ExitCode);
            Assert.Equal(expected, interpreter.StandardOutput);
            Assert.Equal(string.Empty, interpreter.StandardError);

            var emitted = await CompileAndRunAsync(
                CreateEmptyDirectory(root, "gsc-emit"),
                Source);
            Assert.Equal(0, emitted.Compile.ExitCode);
            Assert.Equal(string.Empty, emitted.Compile.StandardError);
            Assert.Equal(0, emitted.Execution.ExitCode);
            Assert.Equal(expected, emitted.Execution.StandardOutput);
            Assert.Equal(string.Empty, emitted.Execution.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FallthroughGuard_PreservesInvalidOperationExceptionType()
    {
        const string Source = """
            import System

            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            try {
                F(DateTimeKind(99))
            } catch (ex InvalidOperationException) {
                Console.WriteLine(ex.Message)
            }
            """;
        var expected = GuardMessage + Environment.NewLine;
        var root = CreateEmptyProbeRoot("Caught");

        try
        {
            var compilerEvaluation = RunSourceDriver(
                CreateEmptyDirectory(root, "gsc-eval"),
                Source,
                Program.Main);
            Assert.Equal(0, compilerEvaluation.ExitCode);
            Assert.Equal(expected + $"Success.{Environment.NewLine}", compilerEvaluation.StandardOutput);
            Assert.Equal(string.Empty, compilerEvaluation.StandardError);

            var interpreter = RunSourceDriver(
                CreateEmptyDirectory(root, "gsi"),
                Source,
                GSharp.Repl.Program.Main);
            Assert.Equal(0, interpreter.ExitCode);
            Assert.Equal(expected, interpreter.StandardOutput);
            Assert.Equal(string.Empty, interpreter.StandardError);

            var emitted = await CompileAndRunAsync(
                CreateEmptyDirectory(root, "gsc-emit"),
                Source);
            Assert.Equal(0, emitted.Compile.ExitCode);
            Assert.Equal(string.Empty, emitted.Compile.StandardError);
            Assert.Equal(0, emitted.Execution.ExitCode);
            Assert.Equal(expected, emitted.Execution.StandardOutput);
            Assert.Equal(string.Empty, emitted.Execution.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// ADR-0156 Phase 1: the guard is a runtime exception on every driver, so
    /// the evaluator's GS0100 diagnostic (which carried the function's
    /// declaration location) is gone. What remains observable — and what this
    /// pins so a silently swallowed guard cannot pass — is the crash protocol:
    /// the CLR-host "Unhandled exception." prefix, the exception type and
    /// guard message, and a stack trace rooted in the program's own frames.
    /// </summary>
    [Fact]
    public void FallthroughGuard_RendersClrHostCrashProtocol()
    {
        var source = "import System\n\n"
            + """
            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }

            F(DateTimeKind(99))
            """;
        var root = CreateEmptyProbeRoot("CrashProtocol");

        try
        {
            var compilerEvaluation = RunSourceDriver(
                CreateEmptyDirectory(root, "gsc-eval"),
                source,
                Program.Main);
            Assert.Equal(ExpectedUnhandledExceptionExitCode, compilerEvaluation.ExitCode);
            AssertCrashProtocol(compilerEvaluation.StandardError);

            var interpreter = RunSourceDriver(
                CreateEmptyDirectory(root, "gsi"),
                source,
                GSharp.Repl.Program.Main);
            Assert.Equal(ExpectedUnhandledExceptionExitCode, interpreter.ExitCode);
            AssertCrashProtocol(interpreter.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertCrashProtocol(string standardError)
    {
        Assert.StartsWith(
            $"Unhandled exception. System.InvalidOperationException: {GuardMessage}",
            standardError,
            StringComparison.Ordinal);
        Assert.Contains("   at Default.<Program>.<Main>$(String[] args)", standardError, StringComparison.Ordinal);
        Assert.DoesNotContain("MethodBaseInvoker", standardError, StringComparison.Ordinal);
    }

    private static int ExpectedUnhandledExceptionExitCode
        => OperatingSystem.IsWindows() ? unchecked((int)0xE0434352) : 134;

    private static object[] Case(string name, string source) => new object[] { name, source };

    private static string CreateEmptyProbeRoot(string name)
    {
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3006-{name}-{Guid.NewGuid():N}");
        Assert.False(Directory.Exists(root));
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        return root;
    }

    private static string CreateEmptyDirectory(string root, string name)
    {
        var directory = Path.Combine(root, name);
        Assert.False(Directory.Exists(directory));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        return directory;
    }

    private static DriverResult RunSourceDriver(
        string directory,
        string source,
        Func<string[], int> driver)
    {
        var sourcePath = Path.Combine(directory, "Probe.gs");
        File.WriteAllText(sourcePath, source);
        return CaptureDriver(() => driver(new[] { sourcePath }));
    }

    private static async Task<(DriverResult Compile, DriverResult Execution)> CompileAndRunAsync(
        string directory,
        string source)
    {
        var sourcePath = Path.Combine(directory, "Probe.gs");
        var assemblyPath = Path.Combine(directory, "Probe.dll");
        File.WriteAllText(sourcePath, source);
        var compile = CaptureDriver(() => Program.Main(new[]
        {
            "/out:" + assemblyPath,
            "/target:exe",
            "/targetframework:net10.0",
            sourcePath,
        }));
        if (compile.ExitCode != 0)
        {
            return (compile, new DriverResult(-1, string.Empty, string.Empty));
        }

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add(assemblyPath);
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Could not start emitted program.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await process.WaitForExitAsync(timeout.Token);
        return (compile, new DriverResult(
            process.ExitCode,
            await stdout,
            await stderr));
    }

    private static DriverResult CaptureDriver(Func<int> driver)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = driver();
            return new DriverResult(exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string GetRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new InvalidOperationException("Could not locate repository root.");
    }

    private sealed record DriverResult(int ExitCode, string StandardOutput, string StandardError);
}
