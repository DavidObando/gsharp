// <copyright file="Issue2953FixedReturnFallthroughGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2953: compiler-generated return epilogues must not turn unmatched
/// exhaustive-switch fallthrough into a default return value.
/// </summary>
public class Issue2953FixedReturnFallthroughGuardTests
{
    private const string GuardMessage = DiagnosticDescriptors.NonVoidFallthroughGuardMessage;

    /// <summary>Gets fixed and protected-return shapes that must reach the fallthrough guard.</summary>
    public static IEnumerable<object[]> FallthroughCases()
    {
        yield return Case("FixedArm", """
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        unsafe {
                            fixed p *int32 = values {
                                return *p
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("SealedPatternFixed", """
            sealed interface Expr { }
            class Literal : Expr { }
            func F(x Expr, values []int32) int32 {
                switch x {
                    case _ is Literal {
                        unsafe {
                            fixed p *int32 = values {
                                return *p
                            }
                        }
                    }
                }
            }
            Console.WriteLine(F(nil, []int32{7}))
            """);
        yield return Case("NestedFixed", """
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        unsafe {
                            fixed p *int32 = values {
                                fixed q *int32 = values {
                                    return *q
                                }
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("SwitchInsideFixed", """
            func F(x DateTimeKind, values []int32) int32 {
                unsafe {
                    fixed p *int32 = values {
                        switch x {
                            case DateTimeKind.Unspecified { return *p }
                            case DateTimeKind.Utc { return 2 }
                            case DateTimeKind.Local { return 3 }
                        }
                    }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("FixedInsideLoop", """
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        for {
                            unsafe {
                                fixed p *int32 = values {
                                    return *p
                                }
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("FixedInsideTry", """
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        try {
                            unsafe {
                                fixed p *int32 = values {
                                    return *p
                                }
                            }
                        } finally {
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("TryInsideFixed", """
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        unsafe {
                            fixed p *int32 = values {
                                try {
                                    return *p
                                } finally {
                                }
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99), []int32{7}))
            """);
        yield return Case("PlainTry", """
            func F(x DateTimeKind) int32 {
                try {
                    switch x {
                        case DateTimeKind.Unspecified { return 1 }
                        case DateTimeKind.Utc { return 2 }
                        case DateTimeKind.Local { return 3 }
                    }
                } finally {
                }
            }
            Console.WriteLine(F(DateTimeKind(99)))
            """);
        yield return Case("Scope", """
            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        scope {
                            return 1
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind(99)))
            """);
    }

    [Theory]
    [MemberData(nameof(FallthroughCases))]
    public void UnmatchedExhaustiveSwitch_LoadsAndThrowsInChildProcess(string name, string source)
    {
        var execution = CompileLoadAndRun(name, source);

        Assert.NotEqual(0, execution.ExitCode);
        Assert.Equal(string.Empty, execution.StandardOutput);
        Assert.Contains($"System.InvalidOperationException: {GuardMessage}", execution.StandardError);
    }

    [Fact]
    public void FixedReturnPath_BypassesGuardAndReturnsValue()
    {
        const string Source = """
            package Issue2953.ValidFixedReturn
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
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            Console.WriteLine(F(DateTimeKind.Unspecified, []int32{7}))
            """;

        var execution = CompileLoadAndRun("ValidFixedReturn", Source);

        Assert.Equal(0, execution.ExitCode);
        Assert.Equal($"7{Environment.NewLine}", execution.StandardOutput);
        Assert.Equal(string.Empty, execution.StandardError);
    }

    [Fact]
    public void ProtectedReturnPath_BypassesGuardAndReturnsValue()
    {
        const string Source = """
            package Issue2953.ValidProtectedReturn
            import System
            func F() int32 {
                try {
                    return 8
                } finally {
                }
            }
            Console.WriteLine(F())
            """;

        var execution = CompileLoadAndRun("ValidProtectedReturn", Source);

        Assert.Equal(0, execution.ExitCode);
        Assert.Equal($"8{Environment.NewLine}", execution.StandardOutput);
        Assert.Equal(string.Empty, execution.StandardError);
    }

    [Fact]
    public void VoidProtectedFallthrough_DoesNotEmitNonVoidGuard()
    {
        const string Source = """
            package Issue2953.VoidProtectedFallthrough
            import System
            func F(condition bool) {
                try {
                    if condition {
                        return
                    }
                } finally {
                }
                Console.WriteLine("done")
            }
            F(false)
            """;

        var execution = CompileLoadAndRun("VoidProtectedFallthrough", Source);

        Assert.Equal(0, execution.ExitCode);
        Assert.Equal($"done{Environment.NewLine}", execution.StandardOutput);
        Assert.Equal(string.Empty, execution.StandardError);
    }

    [Fact]
    public void NonExhaustiveSwitch_WithRewrittenReturnStillReportsGs0100()
    {
        var sources = new[]
        {
            """
            package Issue2953.NonExhaustiveFixed
            func F(x int32, values []int32) int32 {
                switch x {
                    case 0 {
                        unsafe {
                            fixed p *int32 = values {
                                return *p
                            }
                        }
                    }
                }
            }
            """,
            """
            package Issue2953.NonExhaustiveProtected
            func F(x int32) int32 {
                try {
                    switch x {
                        case 0 { return 1 }
                    }
                } finally {
                }
            }
            """,
        };

        foreach (var source in sources)
        {
            using var peStream = new MemoryStream();
            var result = new Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream);

            var diagnostic = Assert.Single(result.Diagnostics);
            Assert.False(result.Success);
            Assert.Equal("GS0100", diagnostic.Id);
            Assert.Equal(0, peStream.Length);
        }
    }

    private static object[] Case(string name, string body)
        => new object[]
        {
            name,
            $"package Issue2953.{name}{Environment.NewLine}import System{Environment.NewLine}{body}",
        };

    private static ExecutionResult CompileLoadAndRun(string name, string source)
    {
        using var peStream = new MemoryStream();
        var emit = new Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream);
        Assert.True(
            emit.Success,
            string.Join(Environment.NewLine, emit.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var bytes = peStream.ToArray();
        var assembly = EmittedFixture.Load(bytes);
        Assert.NotEmpty(assembly.GetTypes());

        var stem = $"Issue2953_{name}_{Guid.NewGuid():N}";
        var directory = Directory.GetCurrentDirectory();
        var assemblyPath = Path.Combine(directory, stem + ".dll");
        var runtimeConfigPath = Path.Combine(directory, stem + ".runtimeconfig.json");
        try
        {
            File.WriteAllBytes(assemblyPath, bytes);
            File.WriteAllText(
                runtimeConfigPath,
                """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": {
                      "name": "Microsoft.NETCore.App",
                      "version": "10.0.0"
                    }
                  }
                }
                """);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(runtimeConfigPath);
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start compiled issue #2953 probe.");
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30_000))
            {
                process.Kill(entireProcessTree: true);
                Assert.Fail($"{name} execution timed out.");
            }

            var standardOutput = stdoutTask.GetAwaiter().GetResult();
            var standardError = stderrTask.GetAwaiter().GetResult();
            return new ExecutionResult(process.ExitCode, standardOutput, standardError);
        }
        finally
        {
            File.Delete(assemblyPath);
            File.Delete(runtimeConfigPath);
        }
    }

    private sealed record ExecutionResult(
        int ExitCode,
        string StandardOutput,
        string StandardError);
}
