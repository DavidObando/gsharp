// <copyright file="Issue2465SpanFromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>End-to-end compile, ILVerify, and runtime coverage for issue #2465.</summary>
public class Issue2465SpanFromEndIndexEmitTests
{
    [Fact]
    public void SpanFromEnd_ReadWriteCompoundAndSystemIndex_IlVerifiesAndRuns()
    {
        const string Source = """
            package Issue2465Compiler
            import System

            func Run(values []int32) int32 {
                var span Span[int32] = values
                let last = Index(1, true)
                span[^1] = span[last] + 7
                span[^2] += 10
                span[^3]++
                return span[0] * 1000 + span[1] * 100 + span[2] * 10 + span[3]
            }

            Console.WriteLine(Run([]int32{ 1, 2, 3, 4 }))
            """;

        var workDir = Path.Combine(
            Environment.CurrentDirectory,
            "out",
            "test-artifacts",
            "issue2465-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            var sourcePath = Path.Combine(workDir, "test.gs");
            var assemblyPath = Path.Combine(workDir, "test.dll");
            File.WriteAllText(sourcePath, Source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var originalOut = Console.Out;
            var originalErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(originalOut);
                Console.SetError(originalErr);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(assemblyPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec failed ({process.ExitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
            Assert.Equal("1441\n", stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
