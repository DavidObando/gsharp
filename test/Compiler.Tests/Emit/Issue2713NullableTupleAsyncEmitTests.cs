// <copyright file="Issue2713NullableTupleAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2713: async functions returning a tuple with a nullable-reference
/// element must remain Task-wrapped at call sites.
/// </summary>
public sealed class Issue2713NullableTupleAsyncEmitTests
{
    [Fact]
    public void ExactOahuCoreNullableTupleAwait_DiagnosticsDropFromSevenToZero()
    {
        const string source = """
            package Oahu.Core

            import System
            import System.Threading.Tasks

            async func ReadAsync() (string?, int32) {
                await Task.Yield()
                return ("oahu", 7)
            }

            async func RunAsync() int32 {
                let (text, value) = await ReadAsync()
                let first = text
                let second = value
                let third = text
                Console.WriteLine(text!!)
                return value
            }
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        var errors = compilation.BoundProgram.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();

        Assert.True(
            errors.Length == 0,
            $"The exact Oahu.Core regression must drop from 7 diagnostics to 0:{Environment.NewLine}"
                + string.Join(Environment.NewLine, errors.Select(diagnostic => diagnostic.ToString())));
    }

    [Fact]
    public void MinimalNullableTupleAsyncAwait_VerifiesAndRuns()
    {
        const string source = """
            package Issue2713

            import System
            import System.Threading.Tasks

            async func ReadAsync() (string?, int32) {
                await Task.Yield()
                return ("ok", 7)
            }

            async func RunAsync() int32 {
                let (text, value) = await ReadAsync()
                Console.WriteLine(text!!)
                return value
            }

            Console.WriteLine(RunAsync().GetAwaiter().GetResult())
            """;

        Assert.Equal("ok\n7\n", CompileVerifyAndRun(source));
    }

    [Fact]
    public void NonAsyncNullableTuple_RemainsNonAwaitable()
    {
        const string source = """
            package Issue2713Negative

            func Read() (string?, int32) {
                return ("no task", 7)
            }

            async func Run() int32 {
                let (text, value) = await Read()
                return value
            }
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        var diagnostics = compilation.BoundProgram.Diagnostics;

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0133");
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2713Emit");
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):{Environment.NewLine}{stdout}{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath,
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
        return output.Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
