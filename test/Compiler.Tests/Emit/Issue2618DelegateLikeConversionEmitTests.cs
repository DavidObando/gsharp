// <copyright file="Issue2618DelegateLikeConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2618: user callable values retain delegate variance when passed to
/// source constructors, while ordinary classes remain invalid lambda targets.
/// </summary>
public class Issue2618DelegateLikeConversionEmitTests
{
    [Fact]
    public void LambdaAndMethodValue_UserFunctionConstructor_Run()
    {
        const string Source = """
            package P
            import System

            class State {
                var Value int32
            }

            class RelayLike {
                let execute (State) -> void
                init(action (State) -> void) {
                    execute = action
                }
                func Execute() {
                    execute(State{Value: 7})
                }
            }

            class Handler {
                func OnState(state State) {
                    Console.WriteLine(state.Value)
                }
            }

            func Main() {
                let nullableAction = (state State?) -> {
                    if state != nil {
                        Console.WriteLine(state.Value)
                    }
                }
                RelayLike(nullableAction).Execute()
                let handler = Handler()
                RelayLike(handler.OnState).Execute()
            }
            """;

        Assert.Equal("7\n7\n", CompileAndRun(Source));
    }

    [Fact]
    public void ArbitraryClass_RemainsInvalidLambdaTarget()
    {
        const string Source = """
            class Ordinary {}

            func Main() {
                let invalid Ordinary = () -> {}
            }
            """;

        Assert.Contains("GS0155", CompileForDiagnostics(Source));
    }

    private static string CompileAndRun(string source)
    {
        string directory = NewDirectory();
        string sourcePath = Path.Combine(directory, "test.gs");
        string assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        try
        {
            using var stdout = new StringWriter();
            var previous = Console.Out;
            Console.SetOut(stdout);
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
                Console.SetOut(previous);
            }

            Assert.True(exitCode == 0, stdout.ToString());
            IlVerifier.Verify(assemblyPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, error);
            return output.Replace("\r\n", "\n");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileForDiagnostics(string source)
    {
        string directory = NewDirectory();
        string sourcePath = Path.Combine(directory, "test.gs");
        string assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        try
        {
            using var stdout = new StringWriter();
            var previous = Console.Out;
            Console.SetOut(stdout);
            try
            {
                Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previous);
            }

            return stdout.ToString();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string NewDirectory()
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2618",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
