// <copyright file="Issue2621ImportedGenericConstructorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2621ImportedGenericConstructorEmitTests
{
    private const string FixtureSource = """
        package Issue2621.Fixture

        class Bucket[T] {
            private var capacity int32

            init() {
                capacity = 0
            }

            init(capacity int32) {
                this.capacity = capacity
            }

            prop Capacity int32 -> capacity
        }
        """;

    [Fact]
    public void ImportedGenericConstructor_Overloads_CompileAndRun()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2621-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var fixturePath = CompileFixture(directory);
            const string source = """
                package Oahu.Cli.Commands
                import System
                import System.Collections.Generic
                import Issue2621.Fixture

                let bucket = Bucket[string](7)
                let empty = Bucket[string]()
                let rows = List[IReadOnlyDictionary[string, object?]](3)
                Console.WriteLine(bucket.Capacity)
                Console.WriteLine(empty.Capacity)
                Console.WriteLine(rows.Capacity)
                """;
            var outputPath = Path.Combine(directory, "Oahu.Cli.dll");
            var result = Compile(directory, source, outputPath, fixturePath);
            Assert.True(result.ExitCode == 0, $"compile failed\n{result.Stdout}\n{result.Stderr}");
            IlVerifier.Verify(outputPath, additionalReferences: new[] { fixturePath });
            Assert.Equal("7\n0\n3\n", Run(outputPath));

            const string invalidSource = """
                package Oahu.Cli.Commands
                import Issue2621.Fixture

                let bucket = Bucket[string]("bad")
                """;
            var invalid = Compile(
                directory,
                invalidSource,
                Path.Combine(directory, "Invalid.dll"),
                fixturePath,
                target: "library");
            var diagnostics = invalid.Stdout + invalid.Stderr;
            Assert.NotEqual(0, invalid.ExitCode);
            Assert.Contains("GS0267", diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0130", diagnostics, StringComparison.Ordinal);
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

    private static string CompileFixture(string directory)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var outputPath = Path.Combine(directory, "Issue2621.Fixture.dll");
        File.WriteAllText(sourcePath, FixtureSource);
        var result = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            sourcePath,
        });
        Assert.True(result.ExitCode == 0, $"fixture compile failed\n{result.Stdout}\n{result.Stderr}");
        return outputPath;
    }

    private static (int ExitCode, string Stdout, string Stderr) Compile(
        string directory,
        string source,
        string outputPath,
        string fixturePath,
        string target = "exe")
    {
        var sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputPath) + ".gs");
        File.WriteAllText(sourcePath, source);
        return RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/reference:" + fixturePath,
            sourcePath,
        });
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
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
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }
}
