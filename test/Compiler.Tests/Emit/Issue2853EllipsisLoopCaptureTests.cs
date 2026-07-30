// <copyright file="Issue2853EllipsisLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2853: numeric ellipsis loop captures use a fresh variable cell per iteration.
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

        AssertEnginesAgree(Source, expected: 0, nameof(ClosureCapturesValueFromCreatingIteration));
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

        AssertEnginesAgree(Source, expected: 3, nameof(CapturedWriteAdvancesLoopControlVariable));
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

        AssertEnginesAgree(Source, expected: 21, nameof(CapturedFunctionLocalWritesSharedCell));
    }

    private static void AssertEnginesAgree(string source, int expected, string testName)
    {
        var evaluation = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(evaluation.Diagnostics);
        Assert.Equal(expected, evaluation.Value);
        Assert.Equal($"{expected}\n", CompileAndRun(source, testName));
    }

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
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n");
    }
}
