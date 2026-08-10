// <copyright file="Issue3224BoxedConstantEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3224: equality between an <c>object</c>-typed operand and a value
/// that boxes in (the Issue #1923 boxed-constant seam, <c>answer == 42</c>
/// where <c>answer</c> is typed <c>object</c>) uses ADR-0045 reference
/// equality. Each value operand boxes independently before the comparison.
/// </summary>
public sealed class Issue3224BoxedConstantEqualityEmitTests
{
    [Fact]
    public void BoxedConstantReferenceEquality_RunsAndVerifies()
    {
        const string Source = """
            package Issue3224

            import System

            let answer object = 42
            Console.WriteLine(answer == 42)
            Console.WriteLine(answer != 42)
            Console.WriteLine(answer == 41)
            Console.WriteLine(answer != 41)

            var n int32 = 42
            Console.WriteLine(answer == n)

            let text object = "hi"
            Console.WriteLine(text == "hi")

            if answer == 42 {
                Console.WriteLine("branch")
            }
            """;

        Assert.Equal(
            $"False{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}True{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3224_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{stdout}{stderr}");
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
            }) ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}:{Environment.NewLine}{error}");
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
