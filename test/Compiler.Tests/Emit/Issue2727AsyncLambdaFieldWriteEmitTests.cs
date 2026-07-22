// <copyright file="Issue2727AsyncLambdaFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2727: field writes through a captured <c>this</c> in an async lambda
/// must be redirected through both the closure and async state-machine receivers.
/// </summary>
public class Issue2727AsyncLambdaFieldWriteEmitTests
{
    [Fact]
    public void ExactQueueScreenLoadAsync_PostAwaitFieldWrites_VerifyAndRun()
    {
        const string Source = """
            package Oahu.Cli.Tui.Screens

            import System
            import System.Threading.Tasks

            class QueueScreen() {
                private var entries int32
                private var cursor int32
                private var statusMessage string? = nil

                prop Result string -> "${entries}:${cursor}:${statusMessage ?? "ok"}"

                func LoadAsync() Task {
                    return Task.Run(async () -> {
                        try {
                            await Task.Yield()
                            entries = 42
                            cursor = 2
                        } catch (ex Exception) {
                            statusMessage = "Failed to load queue: ${ex.Message}"
                            entries = 0
                        }
                    })
                }
            }

            let screen = QueueScreen()
            screen.LoadAsync().GetAwaiter().GetResult()
            Console.WriteLine(screen.Result)
            """;

        Assert.Equal("42:2:ok\n", CompileVerifyAndRun(Source, "ExactQueueScreen"));
    }

    [Fact]
    public void AsyncLambda_FieldWritesBeforeAndAfterAwaitAndInCatch_VerifyAndRun()
    {
        const string Source = """
            package Issue2727TryCatch

            import System
            import System.Threading.Tasks

            class Worker() {
                private var value int32
                private var caught bool
                prop Result string -> "${value}:${caught}"

                func RunAsync() Task {
                    return Task.Run(async () -> {
                        this.value = 1
                        try {
                            await Task.Yield()
                            this.value = 2
                            throw InvalidOperationException("expected")
                        } catch (ex Exception) {
                            await Task.Yield()
                            this.value = 3
                            this.caught = ex.Message == "expected"
                        }
                    })
                }
            }

            let worker = Worker()
            worker.RunAsync().GetAwaiter().GetResult()
            Console.WriteLine(worker.Result)
            """;

        Assert.Equal("3:True\n", CompileVerifyAndRun(Source, "PrePostAwaitCatch"));
    }

    [Fact]
    public void NestedAndEscapingAsyncLambdas_FieldWrites_VerifyAndRun()
    {
        const string Source = """
            package Issue2727Nested

            import System
            import System.Threading.Tasks

            class Worker() {
                private var value int32
                prop Value int32 -> value

                func RunNestedAsync() Task {
                    return Task.Run(async () -> {
                        await Task.Yield()
                        let assign = () -> { this.value = 4 }
                        assign()
                    })
                }

                func MakeEscapingAsync() () -> Task {
                    return async () -> {
                        await Task.Yield()
                        this.value = 5
                    }
                }
            }

            let worker = Worker()
            worker.RunNestedAsync().GetAwaiter().GetResult()
            Console.WriteLine(worker.Value)
            let escaped = worker.MakeEscapingAsync()
            escaped().GetAwaiter().GetResult()
            Console.WriteLine(worker.Value)
            """;

        Assert.Equal("4\n5\n", CompileVerifyAndRun(Source, "NestedEscaping"));
    }

    [Fact]
    public void DirectAsyncMethodAndAsyncLambdaPropertySetter_RemainUnchanged()
    {
        const string Source = """
            package Issue2727Controls

            import System
            import System.Threading.Tasks

            class Worker() {
                private var backing int32
                prop Value int32 {
                    get -> backing
                    set -> this.backing = value
                }

                async func DirectAsync() {
                    this.backing = 6
                    await Task.Yield()
                    this.backing = 7
                }

                func SetPropertyAsync() Task {
                    return Task.Run(async () -> {
                        await Task.Yield()
                        this.Value = 8
                    })
                }
            }

            let worker = Worker()
            worker.DirectAsync().GetAwaiter().GetResult()
            Console.WriteLine(worker.Value)
            worker.SetPropertyAsync().GetAwaiter().GetResult()
            Console.WriteLine(worker.Value)
            """;

        Assert.Equal("7\n8\n", CompileVerifyAndRun(Source, "DirectControls"));
    }

    [Fact]
    public void AsyncLambda_ReadOnlyFieldWrite_IsRejectedAtAssignmentWithoutEmitFailure()
    {
        const string Source = """
            package Issue2727Negative

            import System.Threading.Tasks

            class Worker() {
                private let entries int32 = 0

                func RunAsync() Task {
                    return Task.Run(async () -> {
                        await Task.Yield()
                        this.entries = 1
                    })
                }
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(Source, "Issue2727Negative.gs"));
        var compilation = new Compilation(tree);
        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2727.Negative");

        Assert.False(result.Success);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0127");
        Assert.Equal("=", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    private static string CompileVerifyAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2727Emit", caseName);
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
