// <copyright file="Issue1437CatchInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1437 — a body-introduced local (a <c>catch</c> clause variable, a
/// <c>switch</c> type-pattern binding, etc.) declared inside a <c>func</c>
/// literal / lambda body crashed emit with
/// <c>GS9998: InvalidOperationException: Variable '...' has no local slot or
/// parameter index in the current method.</c>.
/// <para>
/// Root cause: the binder's captured-variable analysis
/// (<c>CapturedVariableCollector</c>) only recorded <c>BoundVariableDeclaration</c>
/// targets as locals declared *within* the lambda. Catch / select-arm / range /
/// pattern variables were therefore misclassified as captures of an enclosing
/// scope. That false capture flowed into the lambda's
/// <c>CapturedVariables</c> set, and <c>CaptureBoxingRewriter</c> hoisted the
/// variable into a heap box — desynchronizing its declaration site (the
/// original symbol, for which the emit local-slot planner allocates a slot)
/// from its in-body reads (rewritten to <c>box.Value</c> against a fresh,
/// slot-less box local).
/// </para>
/// <para>
/// The fix records every body-introduced local from all such constructs as
/// declared, so it is symmetric with how top-level method bodies plan their
/// slots. These tests cover the generalization end-to-end (compile + run):
/// a catch variable used in a lambda, <c>throw ex</c> rethrow in a lambda
/// catch, a lambda that both captures an outer variable and has a try/catch,
/// a try/catch nested inside a <c>let</c>/<c>if</c> block in a lambda, and a
/// switch type-pattern variable in a lambda. Every package/user name is unique
/// so the process-wide <c>FunctionTypeSymbol</c> cache cannot alias across
/// in-process tests.
/// </para>
/// </summary>
public class Issue1437CatchInLambdaEmitTests
{
    [Fact]
    public void EndToEnd_CatchVariableUsedInLambda_Runs()
    {
        var source = """
            package Probe1437a
            import System

            func Main() {
                let f = func () {
                    try {
                        throw Exception("boom1437a")
                    } catch (ex Exception) {
                        Console.WriteLine("caught: " + ex.Message)
                    }
                }
                f()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("caught: boom1437a\n", output);
    }

    [Fact]
    public void EndToEnd_RethrowInLambdaCatch_Runs()
    {
        var source = """
            package Probe1437b
            import System

            func Main() {
                let f = func () {
                    try {
                        try {
                            throw Exception("inner1437b")
                        } catch (ex Exception) {
                            throw ex
                        }
                    } catch (e Exception) {
                        Console.WriteLine("outer caught: " + e.Message)
                    }
                }
                f()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("outer caught: inner1437b\n", output);
    }

    [Fact]
    public void EndToEnd_LambdaCapturesOuterVariableAndHasCatch_Runs()
    {
        var source = """
            package Probe1437c
            import System

            func Main() {
                let prefix = "P1437c:"
                let f = func () {
                    try {
                        throw Exception("z")
                    } catch (ex Exception) {
                        Console.WriteLine(prefix + ex.Message)
                    }
                }
                f()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("P1437c:z\n", output);
    }

    [Fact]
    public void EndToEnd_TryCatchNestedInsideLetBlockInLambda_Runs()
    {
        var source = """
            package Probe1437d
            import System

            func Main() {
                let f = func () {
                    let outer = "O1437d:"
                    if true {
                        let inner = "I"
                        try {
                            throw Exception("q")
                        } catch (ex Exception) {
                            Console.WriteLine(outer + inner + ex.Message)
                        }
                    }
                }
                f()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("O1437d:Iq\n", output);
    }

    [Fact]
    public void EndToEnd_TypePatternVariableInLambda_Runs()
    {
        var source = """
            package Probe1437e
            import System

            func Main() {
                let classify = func (o object) string {
                    return switch o {
                        case s is string: "str:" + s
                        case n is int32: "int"
                        default: "other"
                    }
                }
                Console.WriteLine(classify("hi1437e"))
                Console.WriteLine(classify(5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("str:hi1437e\nint\n", output);
    }

    [Fact]
    public void EndToEnd_NullConditionalInvokeCaptureLocalInLambda_Runs()
    {
        // The `?(…)` operator introduces a synthetic `$ncap_N` capture local
        // referenced inside `WhenNotNull`. When the whole null-conditional sits
        // in a lambda body, that capture local must be treated as a body-local
        // declaration (not misclassified as a capture of an enclosing scope),
        // otherwise emit crashes with GS9998 "Variable '$ncap_N' has no local
        // slot". Here the nullable delegate is a captured parameter.
        var source = """
            package Probe1437f
            import System

            func Build1437f(cb ((int32) -> void)?) () -> void {
                return () -> {
                    cb?(5)
                }
            }

            func Main() {
                var total = 0
                let run = Build1437f((n int32) -> { total = total + n })
                run()
                let noop = Build1437f(nil)
                noop()
                Console.WriteLine(total)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1437_exe_").FullName;
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
