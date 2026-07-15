// <copyright file="Issue2349LambdaIfStatementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2349 — end-to-end compile+run coverage (real <c>gsc</c> pipeline,
/// not the tree-walking interpreter) for a mid-body <c>if</c>/<c>else</c>
/// inside a lambda block body. The parser previously misclassified such a
/// construct as a value-producing if-EXPRESSION purely from its shape (does
/// the chain terminate in a plain <c>else</c>?), without regard to whether
/// it was actually used as a value. A mid-body if/else can never be used as
/// a value — more statements follow it in the same block — so its arms are
/// free to end in ordinary void statements (an assignment, a method call),
/// which produced a spurious GS0124 ("Expression must have a value") at
/// compile time. These tests confirm the fix compiles AND runs correctly
/// end-to-end (verifiable IL, correct runtime output) for sync/async
/// lambdas, nested blocks, and the exact Oahu.Diagnostics
/// <c>rootCmd.SetAction</c> shape.
/// </summary>
public class Issue2349LambdaIfStatementEmitTests
{
    [Fact]
    public void EndToEnd_MidBodyIfElse_AssignmentArms_RunsCorrectly()
    {
        var source = """
            package P2349Basic
            import System
            func Main() {
                let f = (doExport bool) -> {
                    var report = ""
                    if doExport {
                        report = "export"
                    } else {
                        report = "run"
                    }
                    Console.WriteLine(report)
                }
                f(true)
                f(false)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("export\nrun\n", output);
    }

    [Fact]
    public void EndToEnd_MidBodyElseIfChain_RunsCorrectly()
    {
        var source = """
            package P2349ElseIf
            import System
            func Main() {
                let classify = (n int32) -> {
                    if n > 0 {
                        Console.WriteLine("p")
                    } else if n < 0 {
                        Console.WriteLine("n")
                    } else {
                        Console.WriteLine("z")
                    }
                    Console.WriteLine("done")
                }
                classify(5)
                classify(-5)
                classify(0)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("p\ndone\nn\ndone\nz\ndone\n", output);
    }

    [Fact]
    public void EndToEnd_NestedMidBodyIfElse_RunsCorrectly()
    {
        var source = """
            package P2349Nested
            import System
            func Main() {
                let f = (a bool, b bool) -> {
                    if a {
                        if b {
                            Console.WriteLine("ab")
                        } else {
                            Console.WriteLine("a")
                        }
                        Console.WriteLine("after-inner")
                    } else {
                        Console.WriteLine("none")
                    }
                    Console.WriteLine("done")
                }
                f(true, true)
                f(true, false)
                f(false, false)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ab\nafter-inner\ndone\na\nafter-inner\ndone\nnone\ndone\n", output);
    }

    [Fact]
    public void EndToEnd_AsyncLambda_MidBodyIfElse_RunsCorrectly()
    {
        var source = """
            package P2349Async
            import System
            import System.Threading.Tasks
            func Main() {
                let f = async (ok bool) -> {
                    if ok {
                        Console.WriteLine("y")
                    } else {
                        Console.WriteLine("n")
                    }
                    await Task.CompletedTask
                }
                f(true).Wait()
                f(false).Wait()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("y\nn\n", output);
    }

    [Fact]
    public void EndToEnd_TailIfElse_StillValueProducing_Unaffected()
    {
        // Control: tail-position if/else remains a value-producing
        // if-expression and must still compile and run correctly.
        var source = """
            package P2349Tail
            import System
            func Main() {
                let f = (cond bool) -> {
                    if cond { 1 } else { 2 }
                }
                Console.WriteLine(f(true))
                Console.WriteLine(f(false))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void EndToEnd_ExactOahuDiagnosticsShape_TwoMidBodyIfElseBlocks_ThenReturn_RunsCorrectly()
    {
        // The exact real-world shape from tools/Oahu.Diagnostics/Program.cs:
        // an async lambda (`rootCmd.SetAction(async (parse, ct) => { ... })`)
        // with two independent mid-body if/else blocks (each assigning a
        // result variable), followed by further statements and a final
        // `return` with an integer value.
        var source = """
            package P2349Oahu
            import System
            import System.Threading.Tasks
            func Main() {
                let handler = async (doExport bool, useJson bool) -> {
                    var report = ""
                    if doExport {
                        report = "export"
                    } else {
                        report = "run"
                    }

                    if useJson {
                        Console.WriteLine("json: " + report)
                    } else {
                        Console.WriteLine("pretty: " + report)
                    }

                    await Task.CompletedTask
                    return 0
                }
                Console.WriteLine(handler(true, false).Result)
                Console.WriteLine(handler(false, true).Result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("pretty: export\n0\njson: run\n0\n", output);
    }

    [Fact]
    public void EndToEnd_OrdinaryFunction_MidBodyIfElse_ControlUnaffected()
    {
        // Control: ordinary (non-lambda) functions were never affected —
        // must continue to compile and run correctly.
        var source = """
            package P2349Ordinary
            import System
            func F(cond bool) {
                if cond {
                    Console.WriteLine("a")
                } else {
                    Console.WriteLine("b")
                }
                Console.WriteLine("c")
            }
            func Main() {
                F(true)
                F(false)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\nc\nb\nc\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2349_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
