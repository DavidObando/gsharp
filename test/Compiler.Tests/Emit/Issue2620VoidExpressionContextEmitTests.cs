// <copyright file="Issue2620VoidExpressionContextEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2620: discarded tail-if branches may produce <c>void</c>.</summary>
public class Issue2620VoidExpressionContextEmitTests
{
    [Fact]
    public void ExactOahuTailIfLambda_VoidCalls_EmitsAndRuns()
    {
        var source = """
            package Oahu.Cli
            import System

            class CliEnvironment {
                shared {
                    private func RunRestore() {
                        Console.WriteLine("restore")
                    }

                    func InstallExitTrap() Action[bool] {
                        return (first bool) -> {
                            if first {
                                CliEnvironment.RunRestore()
                            } else {
                                CliEnvironment.RunRestore()
                            }
                        }
                    }
                }
            }

            let trap = CliEnvironment.InstallExitTrap()
            trap(true)
            trap(false)
            """;

        Assert.Equal("restore\nrestore\n", CompileAndRun(source));
    }

    [Fact]
    public void TailIfAsyncLambda_VoidAwaitAndCall_EmitAndRun()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func Step(label string) {
                await Task.Yield()
                Console.WriteLine(label)
            }

            let handler = async (first bool) -> {
                if first {
                    await Step("first")
                } else {
                    Console.WriteLine("second")
                }
            }

            handler(true).GetAwaiter().GetResult()
            handler(false).GetAwaiter().GetResult()
            """;

        Assert.Equal("first\nsecond\n", CompileAndRun(source));
    }

    [Fact]
    public void TailIfVoidCalls_UsedAsValue_StillReportGS0124()
    {
        var diagnostics = CompileDiagnostics("""
            package P

            func Restore() {
            }

            let result = if true { Restore() } else { Restore() }
            """);

        Assert.Equal(2, Count(diagnostics, "GS0124"));
    }

    [Fact]
    public void VoidAwait_UsedAsValue_StillReportsGS0124()
    {
        var diagnostics = CompileDiagnostics("""
            package P
            import System.Threading.Tasks

            async func Invalid() {
                let result = await Task.CompletedTask
            }
            """);

        Assert.Equal(1, Count(diagnostics, "GS0124"));
    }

    private static int Count(string text, string value)
    {
        var count = 0;
        var start = 0;
        while ((start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0)
        {
            count++;
            start += value.Length;
        }

        return count;
    }

    private static string CompileDiagnostics(string source)
    {
        string diagnostics = null;
        WithCompilation(source, (exitCode, output, _) =>
        {
            Assert.NotEqual(0, exitCode);
            diagnostics = output;
        });
        return diagnostics;
    }

    private static string CompileAndRun(string source)
    {
        string output = null;
        WithCompilation(source, (exitCode, diagnostics, outputPath) =>
        {
            Assert.True(exitCode == 0, $"compile failed ({exitCode}): {diagnostics}");
            IlVerifier.Verify(outputPath);

            var runtimeConfigPath = Path.ChangeExtension(outputPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outputPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = Process.Start(psi)!;
            output = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}: {stderr}");
        });
        return output?.Replace("\r\n", "\n");
    }

    private static void WithCompilation(string source, Action<int, string, string> verify)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2620_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "test.gs");
            var outputPath = Path.Combine(tempDir, "test.dll");
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

            verify(exitCode, stdout.ToString() + stderr, outputPath);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
