// <copyright file="Issue2703AsyncFilteredCatchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2703: smart-cast exception types must survive async state-machine
/// hoisting in the two filtered-catch shapes emitted for Oahu.Cli.App.
/// </summary>
public class Issue2703AsyncFilteredCatchEmitTests
{
    [Fact]
    public void ExactRunOneAsyncFilteredCatch_VerifiesAndRuns()
    {
        const string Source = """
            package Oahu.Cli.App.Jobs

            import System
            import System.Threading.Tasks

            async func RunOneAsync(canceled bool) string {
                try {
                    await Task.Yield()
                    if canceled {
                        throw OperationCanceledException("canceled")
                    }
                    throw InvalidOperationException("failed")
                } catch (__caught Exception) {
                    if __caught is OperationCanceledException {
                        let __caught = __caught
                        await Task.Yield()
                        return "cancel:" + __caught.Message
                    } else {
                        if __caught is Exception {
                            let ex = __caught
                            await Task.Yield()
                            return "error:" + ex.Message
                        } else {
                            throw __caught
                        }
                    }
                }
            }

            Console.WriteLine(RunOneAsync(true).GetAwaiter().GetResult())
            Console.WriteLine(RunOneAsync(false).GetAwaiter().GetResult())
            """;

        Assert.Equal("cancel:canceled\nerror:failed\n", CompileVerifyAndRun(Source, "RunOneAsync"));
    }

    [Fact]
    public void ExactCheckAudibleApiReachableAsyncFilteredCatch_VerifiesAndRuns()
    {
        const string Source = """
            package Oahu.Cli.App.Doctor

            import System
            import System.Threading.Tasks

            async func CheckAudibleApiReachableAsync(canceled bool) string {
                try {
                    await Task.Yield()
                    if canceled {
                        throw OperationCanceledException("timed out")
                    }
                    throw InvalidOperationException("offline")
                } catch (__caught Exception) {
                    if __caught is OperationCanceledException {
                        let __caught = __caught
                        if canceled {
                            return "timeout:" + __caught.Message
                        } else {
                            if __caught is Exception {
                                let ex = __caught
                                return "error:" + ex.Message
                            } else {
                                throw __caught
                            }
                        }
                    } else {
                        if __caught is Exception {
                            let ex = __caught
                            return "error:" + ex.Message
                        } else {
                            throw __caught
                        }
                    }
                }
            }

            Console.WriteLine(CheckAudibleApiReachableAsync(true).GetAwaiter().GetResult())
            Console.WriteLine(CheckAudibleApiReachableAsync(false).GetAwaiter().GetResult())
            """;

        Assert.Equal(
            "timeout:timed out\nerror:offline\n",
            CompileVerifyAndRun(Source, "CheckAudibleApiReachableAsync"));
    }

    [Fact]
    public void AsyncExceptionDowncast_OutsideTypeGuard_RemainsRejected()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package Issue2703Negative

            import System
            import System.Threading.Tasks

            async func Invalid(ex Exception) {
                if ex is OperationCanceledException {
                    Console.WriteLine(ex.CancellationToken)
                }
                await Task.Yield()
                Console.WriteLine(ex.CancellationToken)
            }
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2703.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError);
    }

    private static string CompileVerifyAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2703Emit", caseName);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n");
    }
}
