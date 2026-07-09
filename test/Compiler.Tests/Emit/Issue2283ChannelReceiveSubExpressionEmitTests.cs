// <copyright file="Issue2283ChannelReceiveSubExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2283 was reported as an <c>ilverify</c> CRASH
/// (<c>IndexOutOfRangeException</c> in
/// <c>Internal.IL.ILImporter.MarkPredecessorWithLowerOffset</c>) compiling
/// control-flow-heavy Oahu.SystemManagement code (nested loops parsing shell
/// output). The private source that triggered the crash is not available, and
/// an extensive search for a minimal repro — nested/labeled loops with
/// <c>break</c>/<c>continue</c>, deeply nested <c>try</c>/<c>catch</c>/
/// <c>finally</c>, pattern-switch statements and expressions, <c>if let</c>/
/// <c>guard let</c>, <c>using let</c>/<c>defer</c>, very long methods forcing
/// long-form branch encoding, goroutines and <c>select</c> — did not reproduce
/// that exact crash. gsc's branch emission goes through
/// <c>System.Reflection.Metadata</c>'s <c>InstructionEncoder</c>/
/// <c>ControlFlowBuilder</c>, which auto-sizes and fixes up branch targets, so
/// a short-branch-overflow or manual offset miscalculation was ruled out as
/// the likely cause.
/// <para>
/// That search did surface a real, confirmed, closely related IL-emission
/// stack-balance bug in the SAME problem domain (protected-region placement
/// relative to the evaluation stack, the class of bug
/// <c>MarkPredecessorWithLowerOffset</c>'s crash strongly implies): a channel
/// receive expression (<c>&lt;-ch</c>) emitted its <c>try</c>/<c>catch</c>
/// (translating a closed-channel exception into <c>default(T)</c>) INLINE at
/// its point of evaluation, unconditionally. Per ECMA-335 III.3.47 a
/// protected region must be entered with an EMPTY evaluation stack. When the
/// receive is a sub-expression of a larger expression — e.g.
/// <c>total = total + &lt;-ch</c>, or inside a loop condition/call argument —
/// earlier operands are already on the stack when the try region opens,
/// producing invalid IL: ilverify reports <c>TryNonEmptyStack</c> and
/// <c>StackUnderflow</c>, and the JIT throws
/// <see cref="InvalidProgramException"/> at run time.
/// </para>
/// <para>
/// The fix follows the existing "stackalloc spilling" pattern from Issue
/// #1522: every <c>BoundChannelReceiveExpression</c> in a statement is
/// materialised — its <c>try</c>/<c>catch</c> executed and result stored to a
/// pre-allocated local — at the START of that statement's emission, when the
/// stack is guaranteed empty (<c>MaterializeSpilledChannelReceives</c> in
/// <c>MethodBodyEmitter.cs</c>, called from <c>EmitStatement</c>). The
/// original expression-position emit (<c>EmitChannelReceiveExpression</c> in
/// <c>MethodBodyEmitter.Calls.cs</c>) then just loads that already-computed
/// result local instead of re-emitting the try/catch in place.
/// </para>
/// These tests compile, ilverify, and run the exact failure shapes: a
/// channel-receive as an operand of <c>+</c>, and the same pattern nested
/// inside a loop with <c>continue</c>/<c>break</c> (mirroring the
/// control-flow-heavy shape from the original report).
/// </summary>
public class Issue2283ChannelReceiveSubExpressionEmitTests
{
    [Fact]
    public void ChannelReceive_AsAdditionOperand_VerifiesAndRuns()
    {
        const string source = """
            package Issue2283.AddOperand
            import System
            import Gsharp.Extensions.Go

            let ch = make(chan int32, 1)
            ch <- 7
            var total = 0
            total = total + <-ch
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void ChannelReceive_InLoopWithBreakAndContinue_VerifiesAndRuns()
    {
        const string source = """
            package Issue2283.LoopBreakContinue
            import System
            import Gsharp.Extensions.Go

            let ch = make(chan int32, 5)
            for var i = 0; i < 5; i++ {
                ch <- i
            }
            var total = 0
            for var i = 0; i < 5; i++ {
                if i == 2 {
                    continue
                }
                total = total + <-ch
                if total > 100 {
                    break
                }
            }
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void ChannelReceive_AsCallArgument_VerifiesAndRuns()
    {
        const string source = """
            package Issue2283.CallArgument
            import System
            import Gsharp.Extensions.Go

            func Sum2283(a int32, b int32) int32 -> a + b

            let ch = make(chan int32, 1)
            ch <- 5
            Console.WriteLine(Sum2283(10, <-ch))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void ChannelReceive_StatementRoot_StillVerifiesAndRuns()
    {
        // Regression guard: a bare `let x = <-ch` (already at an empty-stack
        // root position) is unaffected by the spilling fix and keeps working.
        const string source = """
            package Issue2283.StatementRoot
            import System
            import Gsharp.Extensions.Go

            let ch = make(chan int32, 1)
            ch <- 3
            let v = <-ch
            Console.WriteLine(v)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2283_exe_").FullName;
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
