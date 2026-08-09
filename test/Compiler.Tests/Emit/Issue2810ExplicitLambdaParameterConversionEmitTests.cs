// <copyright file="Issue2810ExplicitLambdaParameterConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2810ExplicitLambdaParameterConversionEmitTests
{
    [Fact]
    public void ExplicitParameterImplicitConversion_Runs()
    {
        const string Source = """
            package Issue2810

            import System
            import System.Collections.Generic
            import System.Linq

            class Number(val int32) {
                func Get() int32 {
                    return val
                }

                func operator implicit(value Number) int32 {
                    return value.Get()
                }
            }

            let nums = List[Number]()
            nums.Add(Number(1))
            nums.Add(Number(2))
            nums.Add(Number(3))
            nums.Add(Number(4))

            for value in nums.Where((x int32) -> x % 2 == 0) {
                Console.WriteLine(value.Get())
            }
            """;

        Assert.Equal($"2{Environment.NewLine}4{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void ExplicitUserTypeParameterImplicitConstruction_Runs()
    {
        const string Source = """
            package Issue2810Reverse

            import System
            import System.Collections.Generic
            class Wrapped(val int32) {
                func Get() int32 {
                    return val
                }

                func operator implicit(value int32) Wrapped {
                    return Wrapped(value)
                }
            }

            let nums = List[int32]()
            nums.Add(1)
            nums.Add(2)
            nums.Add(3)
            nums.Add(4)

            nums.ForEach((x Wrapped) -> Console.WriteLine(x.Get()))
            """;

        Assert.Equal($"1{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}4{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void ExplicitParameterConversion_RunsOncePerInvocation()
    {
        const string Source = """
            package Issue2810Once

            import System
            import System.Collections.Generic
            import System.Linq

            class Number(val int32) {
                func operator implicit(value Number) int32 {
                    Console.WriteLine("convert")
                    return value.val
                }
            }

            let nums = List[Number]()
            nums.Add(Number(1))
            nums.Add(Number(2))

            for value in nums.Where((x int32) -> x > 0 && x % 2 == 0) {
            }
            """;

        Assert.Equal($"convert{Environment.NewLine}convert{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2810_").FullName;
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

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
