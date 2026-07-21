// <copyright file="Issue2691AwaitForNestedCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2691: an await-for iteration variable captured by a nested lambda
/// inside an async lambda had neither closure storage nor a MoveNext slot.
/// </summary>
public class Issue2691AwaitForNestedCaptureEmitTests
{
    [Fact]
    public void OahuHistoryDelete_AsyncLambdaAwaitForNestedAny_RunsAndVerifies()
    {
        const string Source = """
            package Oahu.Cli.Commands
            import System
            import System.Collections.Generic
            import System.Linq
            import System.Threading.Tasks

            class JobRecord(asin string) {
                prop Asin string -> asin
            }

            async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
                yield JobRecord("B")
                await Task.Yield()
                yield JobRecord("A")
            }

            let action = async () -> {
                let asins = []string{ "A" }
                var matches = 0
                await for rec in ReadAllAsync() {
                    let matchesAsin = asins.Any((a string) -> String.Equals(a, rec.Asin, StringComparison.OrdinalIgnoreCase))
                    if matchesAsin {
                        matches += 1
                    }
                }
                return matches
            }

            Console.WriteLine(action().GetAwaiter().GetResult())
            """;

        Assert.Equal("1\n", CompileVerifyAndRun(Source, "Oahu"));
    }

    [Fact]
    public void AwaitFor_EscapingClosures_GetFreshHoistedSlotPerIteration()
    {
        const string Source = """
            package AwaitForCapture
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class JobRecord(asin string) {
                prop Asin string -> asin
            }

            async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
                yield JobRecord("B")
                await Task.Yield()
                yield JobRecord("A")
            }

            async func Run() {
                var readers = List[(() -> string)]()
                await for rec in ReadAllAsync() {
                    readers.Add(() -> rec.Asin)
                }
                Console.WriteLine(readers[0]() + readers[1]())
            }

            Run().GetAwaiter().GetResult()
            """;

        Assert.Equal("BA\n", CompileVerifyAndRun(Source, "Escaping"));
    }

    [Fact]
    public void AwaitFor_VariableOutsideLoop_RemainsRejected()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package AwaitForCaptureNegative
            import System.Collections.Generic

            class JobRecord {}

            async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
                yield JobRecord()
            }

            async func Run() {
                await for rec in ReadAllAsync() {}
                let invalid = () -> rec
            }
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2691.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0125");
    }

    private static string CompileVerifyAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2691Emit", caseName);
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
