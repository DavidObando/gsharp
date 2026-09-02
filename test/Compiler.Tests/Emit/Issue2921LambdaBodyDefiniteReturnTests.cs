// <copyright file="Issue2921LambdaBodyDefiniteReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2921: non-void lambda bodies enforce GS0100 before emission.
/// </summary>
public class Issue2921LambdaBodyDefiniteReturnTests
{
    /// <summary>Gets lambda bodies with a reachable fall-through path.</summary>
    public static IEnumerable<object[]> MissingReturnCases()
    {
        yield return Case("SwitchEscape", """
            package Issue2921.SwitchEscape
            func G(f (int32) -> int32) int32 { return f(1) }
            func F(x int32) int32 {
                return G(func(v int32) int32 {
                    outer: for {
                        switch v {
                            case 1 { break outer }
                            default { return 1 }
                        }
                    }
                })
            }
            public var result = F(0)
            """);
        yield return Case("ConditionalFunctionLiteral", """
            package Issue2921.ConditionalFunctionLiteral
            func G(f (int32) -> int32) int32 { return f(1) }
            func F() int32 {
                return G(func(v int32) int32 { if v == 0 { return 1 } })
            }
            public var result = F()
            """);
        yield return Case("InferredArrowLambda", """
            package Issue2921.InferredArrowLambda
            func Use(f (int32) -> int32) { }
            Use((v int32) -> { if v == 0 { return 1 } })
            """);
        yield return Case("AsyncFunctionLiteral", """
            package Issue2921.AsyncFunctionLiteral
            let bad = async func(v int32) int32 { if v == 0 { return 1 } }
            """);
        yield return Case("TryFinally", """
            package Issue2921.TryFinally
            func Use(f (int32) -> int32) { }
            Use(func(v int32) int32 {
                try { if v == 0 { return 1 } }
                finally { }
            })
            """);
        yield return Case("NestedFunctionLiteral", """
            package Issue2921.NestedFunctionLiteral
            let outer = func() (int32) -> int32 {
                return func(v int32) int32 { if v == 0 { return 1 } }
            }
            """);
        yield return Case("FixedFunctionLiteral", """
            package Issue2921.FixedFunctionLiteral
            func Use(f () -> int32) { }
            func F(xs []int32) {
                Use(func() int32 {
                    unsafe {
                        fixed p *int32 = xs {
                            if xs.Length > 0 { return 1 }
                        }
                    }
                })
            }
            F([]int32{})
            """);
    }

    /// <summary>Gets accepted lambda programs and their expected output.</summary>
    public static IEnumerable<object[]> AcceptedCases()
    {
        yield return Case("OrdinaryShapes", "30\n", """
            package Issue2921.OrdinaryShapes
            import System
            import System.Linq
            import System.Collections.Generic

            let expression = (x int32) -> x + 1
            let block = (x int32) -> {
                if x == 0 { return 10 }
                return x + 1
            }
            let nested = (x int32) -> { return (y int32) -> x + y }

            var seen = 0
            let action = func(v int32) { seen = v }
            action(3)

            let nums = List[int32]()
            nums.Add(2)
            let selected = nums.Select((x) -> { return x * 3 }).Single()
            Console.WriteLine(expression(1) + block(0) + nested(4)(5) + selected + seen)
            """);
        yield return Case("TerminatingBodies", "5\n", """
            package Issue2921.TerminatingBodies
            import System

            let box = Lazy[string](valueFactory: () -> {
                throw InvalidOperationException("not called")
            })
            let forever = func() int32 { for { } }

            var finalCount = 0
            let guarded = func(v int32) int32 {
                try { return v }
                finally { finalCount += 1 }
            }
            Console.WriteLine(guarded(4) + finalCount)
            """);
        yield return Case("AsyncFunctionLiteral", "3\n", """
            package Issue2921.AsyncFunctionLiteralGuard
            import System

            let asyncRead = async func(v int32) int32 { return v + 1 }
            Console.WriteLine(asyncRead(2).Result)
            """);
        yield return Case("FixedFunctionLiteral", "3\n", """
            package Issue2921.FixedFunctionLiteralGuard
            import System

            func F(xs []int32) int32 {
                let read = func() int32 {
                    unsafe {
                        fixed p *int32 = xs {
                            return xs.Length
                        }
                    }
                }
                return read()
            }
            Console.WriteLine(F([]int32{1, 2, 3}))
            """);
    }

    [Theory]
    [MemberData(nameof(MissingReturnCases))]
    public void MissingReturnReportsSingleGs0100AndDoesNotEmit(string name, string source)
    {
        var result = InvokeCompiler(source, name);

        Assert.NotEqual(0, result.ExitCode);
        var errors = result.Output.Split(Environment.NewLine)
            .Where(line => line.Contains("error GS", StringComparison.Ordinal))
            .ToArray();
        Assert.Single(errors);
        Assert.Contains("error GS0100: Not all code paths return a value.", errors[0], StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AcceptedLambdasLoadAndRunInChildProcess(string name, string expectedOutput, string source)
    {
        var result = InvokeCompiler(source, name);

        Assert.Equal(0, result.ExitCode);
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal(expectedOutput, RunBounded(result.AssemblyPath, name));
    }

    [Fact]
    public void UnknownReturnTypeDoesNotCascadeGs0100()
    {
        var result = InvokeCompiler("""
            package Issue2921.UnknownReturnType
            var bad (bool) -> MissingType[int32] = (v bool) -> {
                if v { return MissingFunction() }
            }
            """, "UnknownReturnType");

        Assert.Contains("error GS0113:", result.Output, StringComparison.Ordinal);
        Assert.DoesNotContain("error GS0100:", result.Output, StringComparison.Ordinal);
    }

    private static object[] Case(string name, string source) => new object[] { name, source };

    private static object[] Case(string name, string expectedOutput, string source) =>
        new object[] { name, expectedOutput, source };

    private static (int ExitCode, string Output, string AssemblyPath) InvokeCompiler(string source, string name)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2921LambdaBodyDefiniteReturnTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);
        File.Delete(assemblyPath);
        File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath);
    }

    private static string RunBounded(string assemblyPath, string name)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            Assert.True(process.WaitForExit(5_000), $"{name}: emitted program did not stop after kill");
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
