// <copyright file="Issue2936SourceGenericReceiverCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2936: calls through source-generic member results retain their
/// substituted function type.
/// </summary>
public class Issue2936SourceGenericReceiverCallTests
{
    [Fact]
    public void SourceGenericReceiverReturnedFunction_LoadsAndRuns()
    {
        const string Source = """
            package SourceGenericFunctionReceiver
            import System

            class Src { let N int32
                        init(n int32) { N = n } }

            class Box[T any] { let Value T
                               init(value T) { Value = value }
                               func Get(index int32) T -> Value }

            func Main() {
                let box = Box[(Src) -> int32]((item Src) -> item.N)
                Console.WriteLine(box.Get(0)(Src(5)))
            }
            """;

        var directory = Directory.CreateTempSubdirectory("gsharp_issue2936_").FullName;
        try
        {
            var assemblyPath = Compile(Source, directory);
            IlVerifier.Verify(assemblyPath);
            var assembly = EmittedFixture.Load(assemblyPath);
            Assert.NotEmpty(assembly.GetTypes());
            Assert.Equal($"5{Environment.NewLine}", RunBounded(assemblyPath));
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

    private static string Compile(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "Program.gs");
        var assemblyPath = Path.Combine(directory, "Issue2936.dll");
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
                "/out:" + assemblyPath,
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

        Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(exited, "emitted program timed out");
        Assert.True(process.ExitCode == 0, $"emitted program failed:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }
}
