// <copyright file="Issue2553RepeatedDiscardEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue2553RepeatedDiscardEmitTests
{
    [Fact]
    public void RepeatedDiscards_CompileAndRunAcrossTupleLetAssignmentAndLoop()
    {
        const string source = """
            package main
            import System

            func run() {
                let (kept, _, _) = (10, 20, 30)
                var assigned = 0
                assigned, _, _ = 7, 8, 9
                var loopTotal = 0
                for (first, _, _) in [2](int32, int32, int32){(2, 20, 200), (3, 30, 300)} {
                    loopTotal = loopTotal + first
                }
                Console.WriteLine(kept + assigned + loopTotal)
            }

            run()
            """;

        Assert.Equal("22\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2553_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.Equal(0, exitCode);
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo);
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"dotnet exec failed:\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
