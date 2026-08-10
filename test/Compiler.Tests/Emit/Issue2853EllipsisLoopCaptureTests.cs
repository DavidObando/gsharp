// <copyright file="Issue2853EllipsisLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2853: numeric ellipsis loop captures use a fresh variable cell per iteration.
/// Asserts the emitted program against pinned golden values; the interpreter
/// parity arm was retired with the evaluator in ADR-0156 Phase 3c (#3176).
/// </summary>
public class Issue2853EllipsisLoopCaptureTests
{
    [Fact]
    public void ClosureCapturesValueFromCreatingIteration()
    {
        const string Source = """
            package Issue2853
            import System

            func capture() int32 {
                var callback = () -> { return -1 }

                for i in 0 ... 3 {
                    if i == 0 { callback = () -> { return i } }
                }

                return callback()
            }

            let result = capture()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 0, nameof(ClosureCapturesValueFromCreatingIteration));
    }

    [Fact]
    public void CapturedWriteAdvancesLoopControlVariable()
    {
        const string Source = """
            package Issue2853Write
            import System

            func countIterations() int32 {
                var iterations = 0
                for i in 0 ... 5 {
                    var bump = () -> { i = i + 1 }
                    bump()
                    iterations = iterations + 1
                }

                return iterations
            }

            let result = countIterations()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 3, nameof(CapturedWriteAdvancesLoopControlVariable));
    }

    [Fact]
    public void CapturedFunctionLocalWritesSharedCell()
    {
        const string Source = """
            package Issue2853Write
            import System

            func mutate() int32 {
                var value = 20
                var bump = () -> { value = value + 1 }
                bump()
                return value
            }

            let result = mutate()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 21, nameof(CapturedFunctionLocalWritesSharedCell));
    }

    [Fact]
    public void CapturedIndexWritesUseExpressionTargets()
    {
        const string Source = """
            package Issue2853CapturedIndexWrites
            import System
            import System.Collections.Generic

            func mutate() int32 {
                var slice = []int32{1}
                var values = map[string,int32]{"x": 2}
                var list = List[int32]()
                list.Add(3)
                var read = () -> { return slice[0] + values["x"] + list[0] }

                slice[0] = 40
                values["x"] = 50
                list[0] = 60
                return slice[0] + values["x"] + list[0] + read()
            }

            let result = mutate()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 300, nameof(CapturedIndexWritesUseExpressionTargets));
    }

    [Fact]
    public void CapturedInstanceFieldWritesUseExpressionReceivers()
    {
        const string Source = """
            package Issue2853CapturedFieldWrite
            import System

            class Counter {
                var Value int32
            }

            struct Pair {
                var Value int32
            }

            func mutate() int32 {
                var counter = Counter()
                counter.Value = 5
                var readCounter = () -> { return counter.Value }

                var pair = Pair{Value: 1}
                var readPair = () -> { return pair.Value }
                pair.Value = 6

                return counter.Value + readCounter() + pair.Value + readPair()
            }

            let result = mutate()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 22, nameof(CapturedInstanceFieldWritesUseExpressionReceivers));
    }

    [Fact]
    public void CapturedRefOutAndAliasWritesUseCallerCell()
    {
        const string Source = """
            package Issue2853CapturedRefWrites
            import System

            func addOne(ref value int32) {
                value = value + 1
            }

            func setSeven(out value int32) {
                value = 7
            }

            func mutate() int32 {
                var n = 1
                var readN = () -> { return n }
                let ref alias = n
                alias = alias + 1
                addOne(ref n)

                var m = 0
                var readM = () -> { return m }
                setSeven(out m)

                return n * 1000 + readN() * 100 + m * 10 + readM()
            }

            let result = mutate()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 3377, nameof(CapturedRefOutAndAliasWritesUseCallerCell));
    }

    private static void AssertEmittedResult(string source, int expected, string testName)
        => Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(source, testName));

    private static string CompileAndRun(string source, string testName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2853EllipsisLoopCaptureTests), testName);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        IlVerifier.Verify(assemblyPath);

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, "dotnet exec timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, error);
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
