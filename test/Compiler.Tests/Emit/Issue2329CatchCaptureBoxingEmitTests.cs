// <copyright file="Issue2329CatchCaptureBoxingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2329 — a lambda nested inside an enclosing <c>catch</c> block that
/// captures the catch-clause variable crashed emit with <c>GS9998:
/// InvalidOperationException: Variable '...' has no local slot or parameter
/// index in the current method.</c>
/// <para>
/// Root cause: <c>LambdaBinder.CapturedVariableCollector</c> correctly records
/// the catch variable as captured (this is the inverse of #1437, where the
/// catch sits *inside* the lambda body — here the catch is in the enclosing
/// function and a nested lambda captures its variable). But
/// <see cref="GSharp.Core.CodeAnalysis.Lowering.CaptureBoxingRewriter"/> only
/// allocated a capture-box at a <c>BoundVariableDeclaration</c> (for `var n =
/// e`) or at an inline <c>out var x</c> address-of site (#1453). A catch
/// variable's runtime value is written directly into its ordinary local slot
/// by <c>MethodBodyEmitter.EmitCatchClauses</c>'s <c>stloc</c> — there is no
/// declaration node anywhere in the tree — so the box was never constructed
/// or seeded, leaving the box local itself without an IL slot.
/// </para>
/// <para>
/// The fix generalizes box allocation: when a catch-clause variable is
/// captured, <c>CaptureBoxingRewriter</c> now constructs its box and seeds
/// it from the (still normally-slotted) catch variable at the very start of
/// the (rewritten) catch body, mirroring the existing captured-parameter
/// prologue pattern but scoped to the catch handler instead of function
/// entry. The same gap and fix apply to two structurally identical
/// "declaration-less" locals discovered while auditing adjacent
/// local-introducing constructs per the issue's request: a pattern-switch /
/// switch-expression type-pattern variable (<c>case s is string: ...</c>) and
/// a <c>select</c> receive-bind arm variable (<c>case let v = &lt;-ch { ... }</c>)
/// — both store the runtime value directly into the pattern/arm variable's
/// ordinary slot via specialized emit dispatch, exactly like a catch clause.
/// </para>
/// <para>
/// A <c>for i in a...b</c> loop variable was also audited: it is boxed
/// correctly already, because the general <c>Lowerer</c> desugars it into an
/// ordinary <c>var i = a</c> declaration (feeding the C-style counting loop)
/// during binding, *before* <c>CaptureBoxingRewriter</c> runs — so the
/// existing <c>RewriteVariableDeclaration</c> box path already covers it (and,
/// matching C#'s <c>for</c> loop semantics, all closures over it correctly
/// share one variable cell for the whole loop, not a fresh cell per
/// iteration — a `for x in collection` foreach loop remains intentionally
/// un-boxed, since its per-iteration-fresh variable already matches C#
/// foreach semantics). An unsafe <c>fixed</c> pointer/pinned local capture
/// remains a separate, deferred gap — see the repository notes.
/// </para>
/// Each test compiles, IL-verifies (inside <see cref="CompileAndRun"/>), and
/// runs. Every package name is unique so the process-wide
/// <c>FunctionTypeSymbol</c> cache cannot alias across in-process tests.
/// </summary>
public class Issue2329CatchCaptureBoxingEmitTests
{
    [Fact]
    public void EndToEnd_MinimalCatchCaptureMemberAccess_Runs()
    {
        // The exact minimal repro from the issue body.
        var source = """
            package Probe2329Min
            import System
            func DoWork() {
                try { throw Exception("x") } catch (exc Exception) {
                    let log = () -> Console.WriteLine(exc.Message)
                    log()
                }
            }

            func Main() {
                DoWork()
            }
            """;

        Assert.Equal("x\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_LambdaReadsCaughtVariable_FromFreeFunction_Runs()
    {
        // The catch/lambda pair lives in a plain (non-Main) free function
        // invoked from Main — the shape closest to a real library call site.
        var source = """
            package Probe2329Free
            import System

            func RunIt() {
                try {
                    throw Exception("free-func")
                } catch (exc Exception) {
                    let log = () -> Console.WriteLine(exc.Message)
                    log()
                }
            }

            func Main() {
                RunIt()
            }
            """;

        Assert.Equal("free-func\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_LambdaReadsCaughtVariable_FromInstanceMethod_Runs()
    {
        // The catch/lambda pair lives inside a class instance method.
        var source = """
            package Probe2329Inst
            import System

            open class Worker {
                func Run() {
                    try {
                        throw Exception("inst-method")
                    } catch (exc Exception) {
                        let log = () -> Console.WriteLine(exc.Message)
                        log()
                    }
                }
            }

            func Main() {
                let w = Worker()
                w.Run()
            }
            """;

        Assert.Equal("inst-method\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_LambdaReadAndDerivedWriteOfCaughtVariable_Runs()
    {
        // "Read/write" of the caught variable: the catch variable itself is
        // read-only (like C#'s implicitly-read-only exception variable), so
        // the write half is expressed as writing a value *derived from* the
        // captured variable's read into another captured local — exercising
        // both a box read (exc.Message) and a box write (total) sharing the
        // same catch-entry-seeded box in one lambda body.
        var source = """
            package Probe2329RW
            import System

            func Main() {
                var total = 0
                try {
                    throw Exception("rw")
                } catch (exc Exception) {
                    let record = () -> {
                        total = total + exc.Message.Length
                    }
                    record()
                    record()
                }
                Console.WriteLine(total)
            }
            """;

        // "rw".Length == 2, invoked twice via the same shared box: 4.
        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_TwoLambdasShareCaughtVariableBox_Runs()
    {
        // Two distinct lambdas captured from the same catch clause must
        // observe the same underlying box (shared-cell semantics), not two
        // independently-snapshotted copies.
        var source = """
            package Probe2329Shared
            import System

            func Main() {
                try {
                    throw Exception("shared")
                } catch (exc Exception) {
                    let a = () -> exc.Message
                    let b = () -> exc.Message.Length
                    Console.WriteLine(a())
                    Console.WriteLine(b())
                }
            }
            """;

        Assert.Equal("shared\n6\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_OahuLoggingLogShape_Runs()
    {
        // The exact real-world Oahu shape from the issue:
        //   catch (Exception exc) { Logging.Log(1, this, () => exc.Summary()); }
        // Modeled with a local Log helper (same argument shape: a level, a
        // `this`-typed source, and a trailing closure capturing `exc`) since
        // Oahu itself must not be modified/referenced from this repo.
        var source = """
            package Probe2329Oahu
            import System

            func Log(level int32, source object, f (() -> string)) {
                Console.WriteLine(level.ToString() + ":" + source.ToString() + ":" + f())
            }

            open class Worker {
                func Run() {
                    try {
                        throw Exception("oahu-shape")
                    } catch (exc Exception) {
                        Log(1, this, () -> exc.Message)
                    }
                }
            }

            func Main() {
                let w = Worker()
                w.Run()
            }
            """;

        Assert.Equal("1:Probe2329Oahu.Worker:oahu-shape\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_Issue1437ScenarioRemainsGreen_Runs()
    {
        // #1437 fixed the inverse shape: a try/catch declared *inside* a
        // lambda body. That capture-analysis fix must remain unaffected by
        // this issue's CaptureBoxingRewriter generalization.
        var source = """
            package Probe2329Regress1437
            import System

            func Main() {
                let f = func () {
                    try {
                        throw Exception("boom1437regress")
                    } catch (ex Exception) {
                        Console.WriteLine("caught: " + ex.Message)
                    }
                }
                f()
            }
            """;

        Assert.Equal("caught: boom1437regress\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_PatternSwitchStatementArmVariableCapturedByLambda_Runs()
    {
        // Audit finding: a pattern-switch *statement* arm's type-pattern
        // variable has the identical declaration-less-capture gap as a catch
        // variable — its value is written directly into its ordinary slot by
        // EmitTypePattern, with no BoundVariableDeclaration anywhere.
        var source = """
            package Probe2329PatternStmt
            import System

            func Classify(o object) {
                switch o {
                    case s is string {
                        let log = () -> Console.WriteLine("str:" + s)
                        log()
                    }
                    default {
                        Console.WriteLine("other")
                    }
                }
            }

            func Main() {
                Classify("hello2329")
            }
            """;

        Assert.Equal("str:hello2329\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SwitchExpressionArmVariableCapturedByReturnedLambda_Runs()
    {
        // Audit finding: a switch-*expression* arm's type-pattern variable
        // captured by a lambda that is itself the arm's result (returned out
        // of the enclosing function) — the arm has no statement body to seed
        // a box into, only a Result expression, so the fix wraps it in a
        // BoundBlockExpression.
        var source = """
            package Probe2329PatternExpr
            import System

            func Classify(o object) (() -> string) {
                return switch o {
                    case s is string: () -> "str:" + s
                    default: () -> "other"
                }
            }

            func Main() {
                let f = Classify("hello2329b")
                Console.WriteLine(f())
            }
            """;

        Assert.Equal("str:hello2329b\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SelectReceiveBindVariableCapturedByLambda_Runs()
    {
        // Audit finding: a `select` receive-bind arm variable has the same
        // gap — its value is written into its ordinary slot via the
        // channel's TryRead out-argument, with no declaration node.
        var source = """
            package Probe2329Select
            import System
            import Gsharp.Extensions.Go

            func Main() {
                let ch = make(chan int32, 1)
                ch <- 7
                select {
                case let v = <-ch {
                    let log = () -> Console.WriteLine(v)
                    log()
                }
                }
            }
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2329_exe_").FullName;
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
