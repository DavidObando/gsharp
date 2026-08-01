// <copyright file="Issue2956InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2956 / ADR-0153: script-mode <c>gsi</c> reports self-contained
/// diagnostics for constructs that require the compiled storage model.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2956InterpreterBoundaryTests
{
    [Fact]
    public void FixedArrayReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(FixedArrayReportsCompiledOnlyBoundary),
            """
            import System

            unsafe {
                let values = []int32{1, 2}
                fixed p *int32 = values {
                    Console.WriteLine(values.Length)
                }
            }
            """,
            "'fixed' (pinning) statements are not supported in the interpreter; they require the CIL pinned-local emit path.");
    }

    [Fact]
    public void FixedStringReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(FixedStringReportsCompiledOnlyBoundary),
            """
            import System

            unsafe {
                fixed p *uint16 = "A" {
                    Console.WriteLine(*p)
                }
            }
            """,
            "'fixed' (pinning) statements are not supported in the interpreter; they require the CIL pinned-local emit path.");
    }

    [Fact]
    public void FixedPinnableSpanReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(FixedPinnableSpanReportsCompiledOnlyBoundary),
            """
            import System

            unsafe {
                fixed p *int32 = Span[int32].Empty {
                    Console.WriteLine(*p)
                }
            }
            """,
            "'fixed' (pinning) statements are not supported in the interpreter; they require the CIL pinned-local emit path.");
    }

    [Fact]
    public void StackAllocReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(StackAllocReportsCompiledOnlyBoundary),
            """
            func run() int32 {
                let values = stackalloc [2]int32
                return values.Length
            }

            run()
            """,
            "stackalloc is not supported in the interpreter; it requires the CIL localloc emit path.");
    }

    [Fact]
    public void SizeOfUserStructReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(SizeOfUserStructReportsCompiledOnlyBoundary),
            """
            struct Pair {
                var Left int32
                var Right int32
            }

            unsafe {
                sizeof(Pair)
            }
            """,
            "sizeof on an unmanaged-pointer struct pointee is not supported in the interpreter; it requires the CIL sizeof emit path.");
    }

    [Fact]
    public void FunctionPointerAddressReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(FunctionPointerAddressReportsCompiledOnlyBoundary),
            """
            unsafe func identity(value int32) int32 {
                return value
            }

            unsafe {
                let pointer *func(int32) int32 = &identity
            }
            """,
            "'&Method' function pointers are not supported in the interpreter; they require the CIL ldftn/calli emit path (ADR-0122 §9).");
    }

    [Fact]
    public void FunctionPointerInvocationReportsCompiledOnlyBoundary()
    {
        AssertBoundary(
            nameof(FunctionPointerInvocationReportsCompiledOnlyBoundary),
            """
            unsafe {
                let pointer *func(int32) int32 = nil
                pointer(1)
            }
            """,
            "function-pointer invocation ('fp(args)') is not supported in the interpreter; it requires the CIL calli emit path (ADR-0122 §9).");
    }

    [Fact]
    public void UnsafeBlockWithoutStorageOnlyConstructEvaluatesNormally()
    {
        var result = RunGsi(
            nameof(UnsafeBlockWithoutStorageOnlyConstructEvaluatesNormally),
            """
            import System

            unsafe {
                Console.WriteLine(42)
            }
            """);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("42\n", result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    private static void AssertBoundary(string name, string source, string message)
    {
        var result = RunGsi(name, source);

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(string.Empty, result.StandardOutput);
        Assert.Contains($"GS9999: {message}", result.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunGsi(
        string name,
        string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2956InterpreterBoundaryTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        int exitCode;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            exitCode = GSharp.Repl.Program.Main(new[] { sourcePath });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (
            exitCode,
            stdout.ToString().Replace("\r\n", "\n", StringComparison.Ordinal),
            stderr.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
    }
}
