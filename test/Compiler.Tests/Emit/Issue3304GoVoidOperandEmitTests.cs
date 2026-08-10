// <copyright file="Issue3304GoVoidOperandEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3304: `go` with a void-returning call operand must compile to
/// verifiable IL and run. The void operand lowers through the Action-shaped
/// goroutine thunk (the closure's InvokeAction body is an expression
/// statement, so a void call leaves nothing to pop), for both fire-and-forget
/// and scope-joined launches.
/// </summary>
public class Issue3304GoVoidOperandEmitTests
{
    [Fact]
    public void GoVoidOperandShapes_LoadVerifyAndRun()
    {
        const string Source = """
            package Issue3304GoVoid
            import System
            import Gsharp.Extensions.Go

            class Box {
                func Poke(ch chan int32) {
                    ch <- 7
                }
            }

            func poke(ch chan int32) {
                ch <- 42
            }

            let done = make(chan int32, 1)
            go poke(done)
            Console.WriteLine(<-done)

            let b = Box{}
            go b.Poke(done)
            Console.WriteLine(<-done)

            scope {
                go poke(done)
            }
            Console.WriteLine(<-done)
            """;

        AssertRuns(Source, nameof(GoVoidOperandShapes_LoadVerifyAndRun), "42\n7\n42\n");
    }

    private static void AssertRuns(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(expected, RunBounded(assemblyPath, name));
        }

        IlVerifier.Verify(assemblyPath);
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3304GoVoidOperandEmitTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
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
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath, string name)
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
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(10_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
