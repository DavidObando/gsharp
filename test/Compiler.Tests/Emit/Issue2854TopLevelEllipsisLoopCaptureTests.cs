// <copyright file="Issue2854TopLevelEllipsisLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2854: top-level numeric ellipsis loop captures compile and run.
/// Asserts the emitted program against pinned golden values; the interpreter
/// parity arm was retired with the evaluator in ADR-0156 Phase 3c (#3176).
/// </summary>
public class Issue2854TopLevelEllipsisLoopCaptureTests
{
    [Fact]
    public void TopLevelClosureCapturesIterationVariable()
    {
        const string Source = """
            package Issue2854
            import System

            var callback = () -> { return -1 }

            for i in 0 ... 1 {
                callback = () -> { return i }
            }

            let result = callback()
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 0, nameof(TopLevelClosureCapturesIterationVariable));
    }

    [Fact]
    public void TopLevelForInCapturedWriteUsesSharedCell()
    {
        const string Source = """
            package Issue2854ForIn
            import System

            var source = []int32{7, 8}
            var total = 0
            for value in source {
                var bump = () -> { value = value + 100 }
                bump()
                total = total + value
            }

            let result = total
            Console.WriteLine(result)
            result
            """;

        AssertEmittedResult(Source, expected: 215, nameof(TopLevelForInCapturedWriteUsesSharedCell));
    }

    private static void AssertEmittedResult(string source, int expected, string testName)
        => Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(source, testName));

    private static string CompileAndRun(string source, string testName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2854TopLevelEllipsisLoopCaptureTests), testName);
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
