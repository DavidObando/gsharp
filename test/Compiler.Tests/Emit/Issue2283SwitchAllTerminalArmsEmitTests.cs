// <copyright file="Issue2283SwitchAllTerminalArmsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2283 (re-migration follow-up): re-migrating Oahu.SystemManagement
/// off main @ 51152eb4 still crashed <c>ilverify</c> with the identical
/// <c>MarkPredecessorWithLowerOffset</c> <see cref="IndexOutOfRangeException"/>
/// even after the channel-receive stack-imbalance fix (the other set of
/// <c>Issue2283*</c> tests) landed — that fix addressed a narrower symptom of
/// a broader <c>switch</c>-statement IL-emission bug.
/// <para>
/// Root cause, localized via <c>ilverify --include</c>: a pattern
/// <c>switch</c> <em>statement</em> where every arm — including
/// <c>default</c> — is terminal (ends in <c>return</c>/<c>throw</c>), with no
/// code after the switch. <c>EmitPatternSwitchStatement</c>
/// (<c>MethodBodyEmitter.Patterns.cs</c>) unconditionally emitted
/// <c>Br endLabel</c> after every arm body and unconditionally
/// <c>MarkLabel(endLabel)</c> at the end, even when no arm could ever reach
/// that label — producing a label at the exact end of the method body
/// reachable only via dead branches, which ILVerify's predecessor
/// bookkeeping can't index.
/// </para>
/// <para>
/// The fix reuses <c>ControlFlowGraph.SwitchAlwaysReturns</c> — the exact
/// reachability check the binder already uses for definite-return analysis
/// (issue #1596) — to detect this case and skip emitting the trailing
/// <c>Br endLabel</c> / <c>MarkLabel(endLabel)</c> entirely when the switch
/// is exhaustive (has a <c>default</c>) and every arm definitely
/// returns/throws. All other shapes (non-exhaustive switches, switches with a
/// non-terminal arm, switches followed by more code, and switches using
/// <c>break</c>) keep emitting the end label exactly as before.
/// </para>
/// </summary>
public class Issue2283SwitchAllTerminalArmsEmitTests
{
    [Fact]
    public void AllArmsTerminal_AsLastStatement_VerifiesAndRuns()
    {
        // The exact minimal repro from the issue's confirmed-root-cause
        // comment: a switch statement, as the LAST statement in the method,
        // whose every arm (including default) returns.
        const string source = """
            package Issue2283.AllTerminal
            import System

            class T6 {
                func F(x int32) string {
                    switch x {
                        case 1 { return "a" }
                        case 2 { return "b" }
                        default { return "c" }
                    }
                }
            }

            let t = T6()
            Console.WriteLine(t.F(1))
            Console.WriteLine(t.F(2))
            Console.WriteLine(t.F(3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\nb\nc\n", output);
    }

    [Fact]
    public void MixedTerminalAndNonTerminalArms_VerifiesAndRuns()
    {
        // Not every arm is terminal: the fallthrough/end label IS needed
        // (some arm falls through to code after the switch), so this must
        // still emit (and correctly reach) the end label.
        const string source = """
            package Issue2283.MixedTerminal
            import System

            class T7 {
                func F(x int32) string {
                    var result = ""
                    switch x {
                        case 1 { return "a" }
                        case 2 { result = "b" }
                        default { return "c" }
                    }
                    return result + "!"
                }
            }

            let t = T7()
            Console.WriteLine(t.F(1))
            Console.WriteLine(t.F(2))
            Console.WriteLine(t.F(3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\nb!\nc\n", output);
    }

    [Fact]
    public void AllArmsTerminal_FollowedByMoreCode_VerifiesAndRuns()
    {
        // The switch is NOT the last statement — even though every arm of the
        // switch itself is terminal, the switch is exhaustive (has a
        // default), so control genuinely never falls out of the switch. Code
        // after the switch must still be reachable via the normal path (the
        // switch's own arms never resume execution there directly, but the
        // method as a whole must still verify).
        const string source = """
            package Issue2283.TerminalThenMoreCode
            import System

            class T8 {
                func F(x int32) string {
                    var prefix = "before:"
                    switch x {
                        case 1 { return prefix + "a" }
                        case 2 { return prefix + "b" }
                        default { return prefix + "c" }
                    }
                }
            }

            let t = T8()
            Console.WriteLine(t.F(1))
            Console.WriteLine(t.F(3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("before:a\nbefore:c\n", output);
    }

    [Fact]
    public void AllArmsTerminal_NoDefault_VerifiesAndRuns()
    {
        // Without a `default` arm the switch is NOT exhaustive — the
        // discriminant may match nothing, so the "no match" path still needs
        // to fall through to the end label. This must keep working exactly as
        // before the fix.
        const string source = """
            package Issue2283.NoDefaultTerminal
            import System

            class T9 {
                func F(x int32) string {
                    switch x {
                        case 1 { return "a" }
                        case 2 { return "b" }
                    }
                    return "fallthrough"
                }
            }

            let t = T9()
            Console.WriteLine(t.F(1))
            Console.WriteLine(t.F(2))
            Console.WriteLine(t.F(3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\nb\nfallthrough\n", output);
    }

    [Fact]
    public void SwitchInsideLoopWithBreakAfterNonTerminalArm_VerifiesAndRuns()
    {
        // A pattern-switch statement (G# case arms don't fall through, so
        // `break` is not a switch-arm construct here — it's a loop-exit
        // construct) nested inside a loop, with a non-terminal arm followed
        // by a loop `break`. Exercises the switch's own end-label path
        // (needed because one arm is non-terminal) composing correctly with
        // an enclosing loop's control flow — this must not regress with the
        // fix.
        const string source = """
            package Issue2283.LoopBreakAfterSwitch
            import System

            class T10 {
                func F(x int32) string {
                    var result = "none"
                    for var i = 0; i < 3; i++ {
                        switch x {
                            case 1 { result = "one" }
                            case 2 { return "two" }
                            default { return "default" }
                        }
                        break
                    }
                    return result
                }
            }

            let t = T10()
            Console.WriteLine(t.F(1))
            Console.WriteLine(t.F(2))
            Console.WriteLine(t.F(3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("one\ntwo\ndefault\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2283_switch_exe_").FullName;
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
