// <copyright file="Issue2616CharNumericPromotionRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2616 end-to-end runtime and IL verification.</summary>
public class Issue2616CharNumericPromotionRuntimeTests
{
    [Fact]
    public void PromotedCharOperations_RunWithEcmaResults()
    {
        const string Source = """
            package P
            import System

            var a char = '5'
            var b char = '1'
            Console.WriteLine(a - b)
            Console.WriteLine(-a)
            Console.WriteLine(^b)
            Console.WriteLine(a + uint32(1))

            var c char = 'A'
            c += 2
            c ^= char(1)
            Console.WriteLine(c)

            var lifted char? = 'D'
            lifted -= 'A'
            Console.WriteLine(int32(lifted.Value))

            var shifted char? = char(2)
            shifted <<= char(2)
            Console.WriteLine(int32(shifted.Value))
            """;

        Assert.Equal("4\n-53\n-50\n54\nB\n3\n8\n", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2616_").FullName;
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
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
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
            var runtimeOutput = process!.StandardOutput.ReadToEnd();
            var runtimeError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"runtime failed:\n{runtimeOutput}\n{runtimeError}");
            return runtimeOutput.Replace("\r\n", "\n");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
