// <copyright file="Issue2956InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2956 / ADR-0153 / ADR-0156 Phase 1: script-mode <c>gsi</c> executes
/// the compiled storage model natively. The constructs the interpreting driver
/// used to reject with self-contained boundary diagnostics (<c>fixed</c>,
/// <c>stackalloc</c>, <c>sizeof</c> on user structs, function pointers) now
/// compile through the real emitter and run in-process, so each case asserts
/// the construct's observable result instead of a refusal. Since Phase 3c
/// (#3176) the tree-walking evaluator is deleted, so the ADR-0153 boundary is
/// gone everywhere — emitted execution is the only execution.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2956InterpreterBoundaryTests
{
    [Fact]
    public void FixedArrayPinsAndExecutes()
    {
        var result = RunGsi(
            nameof(FixedArrayPinsAndExecutes),
            """
            import System

            unsafe {
                let values = []int32{1, 2}
                fixed p *int32 = values {
                    Console.WriteLine(values.Length)
                }
            }
            """);

        AssertRan(result, "2\n");
    }

    [Fact]
    public void FixedStringPinsAndDereferences()
    {
        var result = RunGsi(
            nameof(FixedStringPinsAndDereferences),
            """
            import System

            unsafe {
                fixed p *uint16 = "A" {
                    Console.WriteLine(*p)
                }
            }
            """);

        AssertRan(result, "65\n");
    }

    [Fact]
    public void FixedEmptySpanPinsNil()
    {
        var result = RunGsi(
            nameof(FixedEmptySpanPinsNil),
            """
            import System

            unsafe {
                fixed p *int32 = Span[int32].Empty {
                    if p == nil {
                        Console.WriteLine("empty-span-pins-nil")
                    }
                }
            }
            """);

        AssertRan(result, "empty-span-pins-nil\n");
    }

    [Fact]
    public void StackAllocExecutes()
    {
        var result = RunGsi(
            nameof(StackAllocExecutes),
            """
            import System

            func run() int32 {
                let values = stackalloc [2]int32
                return values.Length
            }

            Console.WriteLine(run())
            """);

        AssertRan(result, "2\n");
    }

    [Fact]
    public void SizeOfUserStructExecutes()
    {
        var result = RunGsi(
            nameof(SizeOfUserStructExecutes),
            """
            import System

            struct Pair {
                var Left int32
                var Right int32
            }

            unsafe {
                Console.WriteLine(sizeof(Pair))
            }
            """);

        AssertRan(result, "8\n");
    }

    [Fact]
    public void FunctionPointerAddressExecutes()
    {
        var result = RunGsi(
            nameof(FunctionPointerAddressExecutes),
            """
            import System

            unsafe func identity(value int32) int32 {
                return value
            }

            unsafe {
                let pointer *func(int32) int32 = &identity
                Console.WriteLine("took-address")
            }
            """);

        AssertRan(result, "took-address\n");
    }

    [Fact]
    public void FunctionPointerInvocationExecutes()
    {
        var result = RunGsi(
            nameof(FunctionPointerInvocationExecutes),
            """
            import System

            unsafe func identity(value int32) int32 {
                return value
            }

            unsafe {
                let pointer *func(int32) int32 = &identity
                Console.WriteLine(pointer(41) + 1)
            }
            """);

        AssertRan(result, "42\n");
    }

    [Fact]
    public void FunctionPointerNilComparisonsExecute()
    {
        var result = RunGsi(
            nameof(FunctionPointerNilComparisonsExecute),
            """
            import System

            unsafe {
                let pointer *func(int32) int32 = nil
                Console.WriteLine(pointer == nil)
                Console.WriteLine(nil == pointer)
                Console.WriteLine(pointer != nil)
                Console.WriteLine(nil != pointer)
            }
            """);

        AssertRan(result, "True\nTrue\nFalse\nFalse\n");
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

        AssertRan(result, "42\n");
    }

    private static void AssertRan(
        (int ExitCode, string StandardOutput, string StandardError) result,
        string expectedOutput)
    {
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(expectedOutput, result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
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
            stdout.ToString().ReplaceLineEndings(Environment.NewLine),
            stderr.ToString().ReplaceLineEndings(Environment.NewLine));
    }
}
