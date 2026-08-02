// <copyright file="Issue3010EntryPointDriverMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issues #2984 and #3010: entry-point result behavior agrees across compiler
/// evaluation, emitted execution, and interpretation.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3010EntryPointDriverMatrixTests
{
    public enum Driver
    {
        CompilerEvaluation,
        CompilerEmission,
        Interpreter,
    }

    public static IEnumerable<object[]> DriverCases()
    {
        var cases = new[]
        {
            (
                "explicit-int-3",
                """
                import System

                func Main() int32 {
                    Console.WriteLine("main-int")
                    return 3
                }
                """,
                3,
                "main-int\n"),
            (
                "explicit-int-0",
                """
                import System

                func Main() int32 {
                    Console.WriteLine("main-zero")
                    return 0
                }
                """,
                0,
                "main-zero\n"),
            (
                "explicit-void-bare-int",
                """
                import System

                func Main() {
                    Console.WriteLine("void-bare-int")
                    5 + 6
                }
                """,
                0,
                "void-bare-int\n"),
            (
                "explicit-void-ignored-int-call",
                """
                import System

                func Compute() int32 {
                    return 22
                }

                func Main() {
                    Console.WriteLine("void-call")
                    Compute()
                }
                """,
                0,
                "void-call\n"),
            (
                "explicit-void-bare-string",
                """
                import System

                func Main() {
                    Console.WriteLine("void-string")
                    "leaked"
                }
                """,
                0,
                "void-string\n"),
            (
                "explicit-void-print",
                """
                import System

                func Main() {
                    Console.WriteLine("void-print")
                }
                """,
                0,
                "void-print\n"),
            (
                "top-level-bare-int",
                """
                import System

                Console.WriteLine("top-bare")
                16 + 17
                """,
                0,
                "top-bare\n"),
            (
                "top-level-return-3",
                """
                import System

                Console.WriteLine("top-return")
                return 3
                """,
                3,
                "top-return\n"),
        };

        foreach (var (name, source, processExitCode, output) in cases)
        {
            foreach (var driver in Enum.GetValues<Driver>())
            {
                var exitCode = driver == Driver.CompilerEvaluation ? 0 : processExitCode;
                var standardOutput = driver == Driver.CompilerEvaluation
                    ? output + "Success.\n"
                    : output;
                yield return new object[] { name, source, driver, exitCode, standardOutput };
            }
        }
    }

    [Theory]
    [MemberData(nameof(DriverCases))]
    public void EntryPointResultMatrixMatchesDriverContract(
        string name,
        string source,
        Driver driver,
        int expectedExitCode,
        string expectedOutput)
    {
        var result = Run(name, source, driver);

        Assert.Equal(expectedExitCode, result.ExitCode);
        Assert.Equal(expectedOutput, result.StandardOutput);
        Assert.Equal(string.Empty, result.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) Run(
        string name,
        string source,
        Driver driver)
    {
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3010-matrix-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var sourcePath = Path.Combine(root, name + ".gs");
        File.WriteAllText(sourcePath, source);

        try
        {
            return driver switch
            {
                Driver.CompilerEvaluation => CaptureConsole(
                    () => GSharp.Compiler.Program.Main(new[] { sourcePath })),
                Driver.CompilerEmission => CompileAndRun(root, name, sourcePath),
                Driver.Interpreter => CaptureConsole(
                    () => GSharp.Repl.Program.Main(new[] { sourcePath })),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileAndRun(
        string root,
        string name,
        string sourcePath)
    {
        var outputDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(outputDirectory);
        var assemblyPath = Path.Combine(outputDirectory, name + ".dll");
        var compile = CaptureConsole(
            () => GSharp.Compiler.Program.Main(new[] { sourcePath, "/out:" + assemblyPath }));

        Assert.Equal(0, compile.ExitCode);
        Assert.True(File.Exists(assemblyPath), compile.StandardOutput + compile.StandardError);

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        process.WaitForExit();

        return (
            process.ExitCode,
            standardOutput.Replace("\r\n", "\n"),
            standardError.Replace("\r\n", "\n"));
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CaptureConsole(
        Func<int> action)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            return (
                action(),
                output.ToString().Replace("\r\n", "\n"),
                error.ToString().Replace("\r\n", "\n"));
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }
}
