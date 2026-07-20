// <copyright file="Issue2581GeneratedSourceCrashTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

public class Issue2581GeneratedSourceCrashTests
{
    [Fact]
    public void Main_GeneratedSourceAndDiscardedDictionaryKey_EmitsStableAssembly()
    {
        var tempDir = Directory.CreateTempSubdirectory("gsc_2581_").FullName;
        try
        {
            var generatedPath = Path.Combine(tempDir, "Repro.Version.gs");
            var appPath = Path.Combine(tempDir, "App.gs");
            File.WriteAllText(generatedPath, """
                package Repro
                @assembly: System.Reflection.AssemblyVersionAttribute("1.0.0.0")
                """);
            File.WriteAllText(appPath, """
                package Repro
                import System.Collections.Generic

                func Sum(values Dictionary[string, int32]) int32 {
                    var total = 0
                    for (_, value) in values {
                        total += value
                    }
                    return total
                }
                """);

            var first = Compile(tempDir, "first.dll", generatedPath, appPath);
            var second = Compile(tempDir, "second.dll", generatedPath, appPath);

            Assert.Equal(0, first.ExitCode);
            Assert.Equal(0, second.ExitCode);
            Assert.DoesNotContain("GS9998", first.Output);
            Assert.DoesNotContain("GS9998", second.Output);
            Assert.Equal(File.ReadAllBytes(first.OutputPath), File.ReadAllBytes(second.OutputPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Output, string OutputPath) Compile(
        string directory,
        string outputName,
        params string[] sources)
    {
        var outputPath = Path.Combine(directory, outputName);
        using var writer = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(writer);
        try
        {
            var args = new string[sources.Length + 4];
            args[0] = "/out:" + outputPath;
            args[1] = "/target:library";
            args[2] = "/deterministic+";
            args[3] = "/nowarn:GS9100";
            sources.CopyTo(args, 4);
            return (Program.Main(args), writer.ToString(), outputPath);
        }
        finally
        {
            Console.SetOut(previous);
        }
    }
}
