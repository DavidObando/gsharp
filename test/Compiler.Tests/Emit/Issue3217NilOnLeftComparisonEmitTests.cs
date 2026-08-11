// <copyright file="Issue3217NilOnLeftComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3217: a nil literal on the LEFT of <c>==</c> / <c>!=</c>
/// (<c>nil != x</c>) over a value-type <c>T?</c> previously fell through to
/// the emitter's generic <c>ceq</c> tail — the lifted-slot planner and the
/// nil-comparison emit arms only matched the nil-on-right shape — producing
/// unverifiable IL (InvalidProgramException at runtime). The binder now
/// canonicalizes the nil literal to the right; these tests run and ILVerify
/// both orders, in branch-condition and value positions, over value-type and
/// reference-type operands.
/// </summary>
public sealed class Issue3217NilOnLeftComparisonEmitTests
{
    [Fact]
    public void NilOnLeftComparisons_RunAndVerify()
    {
        const string Source = """
            package Issue3217

            import System

            var x int32? = 7
            var y int32 = 0
            if nil != x {
                y = x
            }
            Console.WriteLine(y)

            if nil == x {
                Console.WriteLine("nil")
            } else {
                Console.WriteLine("some")
            }

            var n int32? = nil
            if nil == n {
                Console.WriteLine("isnil")
            }

            Console.WriteLine(nil != x)
            Console.WriteLine(nil == x)
            Console.WriteLine(nil == n)

            var s string? = "hi"
            if nil != s {
                Console.WriteLine(s)
            }
            """;

        Assert.Equal(
            $"7{Environment.NewLine}some{Environment.NewLine}isnil{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}True{Environment.NewLine}hi{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3217_").FullName;
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
