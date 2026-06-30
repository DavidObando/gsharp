// <copyright file="Issue1453CapturedOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1453 — an inline <c>out var x</c> whose value is captured by a nested
/// lambda crashed emit with <c>GS9998: Variable 'x' has no local slot.</c>
/// <para>
/// Root cause: a captured local is hoisted into a per-variable <c>Box</c> class
/// by <see cref="GSharp.Core.CodeAnalysis.Lowering.CaptureBoxingRewriter"/>, but
/// the box local is only allocated (<c>var box = new Box()</c>) when the rewriter
/// visits the original's <c>BoundVariableDeclaration</c>. An inline <c>out var x</c>
/// produces <b>no declaration</b> — it binds straight to an address-of in the
/// call's <c>out</c> argument — so the box local was never declared, leaving it
/// without an IL slot.
/// </para>
/// <para>
/// The fix allocates the box for such declaration-less captured locals at the
/// statement that first introduces them (their address-of site), scoped to the
/// enclosing block. Block-level allocation means a loop body gets a fresh box
/// per iteration, matching how an ordinary <c>var x = e</c> inside a loop body
/// behaves — the closures below observe per-iteration values, not a shared one.
/// </para>
/// Each test compiles, IL-verifies (inside <see cref="CompileAndRun"/>), and runs.
/// </summary>
public class Issue1453CapturedOutVarEmitTests
{
    [Fact]
    public void EndToEnd_TopLevelCapturedOutVar_VerifiesAndRuns()
    {
        // The headline repro: an inline `out var captured` read by a lambda.
        var source = """
            package Probe1453Top
            import System

            open class Q1453Top {
                func TryGet(out v int32) bool {
                    v = 42
                    return true
                }
            }

            func Main() {
                let q = Q1453Top()
                q.TryGet(out var captured)
                let f = func () int32 {
                    return captured + 1
                }
                Console.WriteLine(f())
            }
            """;

        Assert.Equal("43\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_CapturedOutVarInLoopBody_GetsFreshBoxPerIteration()
    {
        // Each iteration's `out var c` must be a fresh box: the three captured
        // closures return 100, 101, 102 (sum 303), not a shared final 102 (306).
        var source = """
            package Probe1453Loop
            import System
            import System.Collections.Generic

            open class Q1453Loop {
                func TryGet(out v int32) bool {
                    v = 100
                    return true
                }
            }

            func Main() {
                let q = Q1453Loop()
                var fns = List[(() -> int32)]()
                for i in 0 ... 3 {
                    q.TryGet(out var c)
                    c = c + i
                    let f = func () int32 {
                        return c
                    }
                    fns.Add(f)
                }
                var total = 0
                for g in fns {
                    total = total + g()
                }
                Console.WriteLine(total)
            }
            """;

        Assert.Equal("303\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_MultipleCapturedOutVarsInOneCall_VerifiesAndRuns()
    {
        // Two inline out-vars introduced by a single call, both captured.
        var source = """
            package Probe1453Multi
            import System

            open class Q1453Multi {
                func TryTwo(out a int32, out b int32) bool {
                    a = 7
                    b = 9
                    return true
                }
            }

            func Main() {
                let q = Q1453Multi()
                q.TryTwo(out var x, out var y)
                let f = func () int32 {
                    return x + y
                }
                Console.WriteLine(f())
            }
            """;

        Assert.Equal("16\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_CapturedOutVarInLoopCondition_VerifiesAndRuns()
    {
        // An out-var introduced in a loop *condition* is attributed to the
        // enclosing block (one box), and its capture in the body is valid.
        var source = """
            package Probe1453Cond
            import System

            open class Q1453Cond {
                func TryGet(out v int32) bool {
                    v = 100
                    return true
                }
            }

            func Main() {
                let q = Q1453Cond()
                var sum = 0
                var count = 0
                for count < 2 && q.TryGet(out var w) {
                    let f = func () int32 {
                        return w
                    }
                    sum = sum + f()
                    count = count + 1
                }
                Console.WriteLine(sum)
            }
            """;

        Assert.Equal("200\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_NonCapturedOutVar_StaysVerifiable()
    {
        // Control: an inline out-var that is *not* captured must keep its
        // ordinary local slot (the box rewriter never runs for it).
        var source = """
            package Probe1453Plain
            import System

            open class Q1453Plain {
                func TryGet(out v int32) bool {
                    v = 42
                    return true
                }
            }

            func Main() {
                let q = Q1453Plain()
                q.TryGet(out var captured)
                Console.WriteLine(captured)
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_OrdinaryCapturedLocalAndOutVarTogether_VerifiesAndRuns()
    {
        // Control: a normally-declared captured local (`var n = ...`) still
        // boxes at its declaration, and coexists with a captured out-var in
        // the same scope without double-allocating either box.
        var source = """
            package Probe1453Mixed
            import System

            open class Q1453Mixed {
                func TryGet(out v int32) bool {
                    v = 40
                    return true
                }
            }

            func Main() {
                let q = Q1453Mixed()
                var n = 2
                q.TryGet(out var captured)
                let f = func () int32 {
                    return captured + n
                }
                Console.WriteLine(f())
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1453_exe_").FullName;
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
