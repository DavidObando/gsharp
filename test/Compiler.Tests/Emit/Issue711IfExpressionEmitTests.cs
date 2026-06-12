// <copyright file="Issue711IfExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #711 / ADR-0064 — end-to-end emit coverage that finalises the
/// if-expression. Each test compiles via in-process <c>gsc</c>, IL-verifies
/// the emitted PE, then executes the assembly under <c>dotnet exec</c> and
/// asserts captured stdout. Mirrors the scenarios called out in the issue's
/// acceptance criteria: value flowing through let-init, call argument,
/// return, nested forms, reference-vs-value branch tail unification, and
/// throw in the prefix of one branch.
/// </summary>
public class Issue711IfExpressionEmitTests
{
    [Fact]
    public void IfExpression_InLetInit_ProducesValue()
    {
        var source = """
            package Test
            import System

            let label = if 5 > 0 { "positive" } else if 5 < 0 { "negative" } else { "zero" }
            Console.WriteLine(label)
            """;

        Assert.Equal("positive\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_AsCallArgument()
    {
        var source = """
            package Test
            import System

            let n = 0
            Console.WriteLine(if n == 0 { "z" } else { "nz" })
            """;

        Assert.Equal("z\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_InReturnStatement()
    {
        var source = """
            package Test
            import System

            func Sign(n int32) string {
                return if n > 0 { "+" } else if n < 0 { "-" } else { "0" }
            }
            Console.WriteLine(Sign(3))
            Console.WriteLine(Sign(-3))
            Console.WriteLine(Sign(0))
            """;

        Assert.Equal("+\n-\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_Nested_TwoLevels()
    {
        var source = """
            package Test
            import System

            let a = true
            let b = false
            let n = if a { if b { 1 } else { 2 } } else { 3 }
            Console.WriteLine(n)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_NumericWidening_PicksWiderType()
    {
        var source = """
            package Test
            import System

            let a int32 = 1
            let b int64 = 2
            let x = if true { a } else { b }
            Console.WriteLine(x)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_NilArm_UnifiesAsNullableReference()
    {
        var source = """
            package Test
            import System

            let s string? = "hi"
            let r = if true { s } else { nil }
            if let v = r {
                Console.WriteLine(v)
            } else {
                Console.WriteLine("nil")
            }
            """;

        Assert.Equal("hi\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_ThrowInPrefix_RunsOnlyChosenArm()
    {
        // The throw in the then-arm only fires when the condition is true.
        // With a false condition the else-arm produces 42 and execution
        // continues normally.
        var source = """
            package Test
            import System

            func Run(b bool) int32 {
                let x = if b {
                    throw Exception(message = "bad")
                    0
                } else {
                    42
                }
                return x
            }
            Console.WriteLine(Run(false))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_MultiStatementBlock_RunsPrefixThenLiftsTrailing()
    {
        var source = """
            package Test
            import System

            var sink = ""
            let title = if true {
                sink = "side-effect"
                "Admin"
            } else {
                "Home"
            }
            Console.WriteLine(title)
            Console.WriteLine(sink)
            """;

        Assert.Equal("Admin\nside-effect\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_ElseIfChain_FourArms()
    {
        var source = """
            package Test
            import System

            func Grade(p int32) string {
                return if p >= 90 { "A" } else if p >= 80 { "B" } else if p >= 70 { "C" } else { "F" }
            }
            Console.WriteLine(Grade(95))
            Console.WriteLine(Grade(85))
            Console.WriteLine(Grade(75))
            Console.WriteLine(Grade(50))
            """;

        Assert.Equal("A\nB\nC\nF\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_OnlyChosenArmIsEvaluated_NoSideEffectOnLosingArm()
    {
        // Side-effect guard: divide-by-zero in the unchosen arm must not
        // execute. This pins down the "lazy" semantics of the if-expression
        // (only one arm is bound and emitted to run).
        var source = """
            package Test
            import System

            let denom = 0
            let pick = true
            let v = if pick { 100 } else { 1 / denom }
            Console.WriteLine(v)
            """;

        Assert.Equal("100\n", CompileAndRun(source));
    }

    [Fact]
    public void IfExpression_ValueAndObject_UnifiesViaBoxing()
    {
        // Cross-kind branch types unify via the common-type rule when one
        // branch is implicitly convertible to the other. Here both arms
        // satisfy the implicit conversion to `object`.
        var source = """
            package Test
            import System

            func Pick(b bool) object {
                return if b { 42 } else { "hi" as object }
            }
            Console.WriteLine(Pick(true))
            Console.WriteLine(Pick(false))
            """;

        Assert.Equal("42\nhi\n", CompileAndRun(source));
    }

    [Fact]
    public void IfStatement_StillWorks_Unchanged()
    {
        // Regression guard: existing `if` statements continue to parse and
        // execute exactly as before — ADR-0064 must NOT break the statement
        // form.
        var source = """
            package Test
            import System

            var x = 0
            if true {
                x = 42
            }
            Console.WriteLine(x)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue711_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
