// <copyright file="Adr0151IfLetExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0151 — end-to-end emit coverage for the value-producing
/// <c>if let</c> expression. Each test compiles via in-process <c>gsc</c>,
/// IL-verifies the emitted PE, then executes the assembly under
/// <c>dotnet exec</c> and asserts captured stdout. The lowering reuses the
/// ADR-0064 <c>BoundConditionalExpression</c> / <c>BoundBlockExpression</c>
/// pair, so these tests exist to prove the emitted IL is verifiable (the
/// binding locals are declared inside an expression-position block) and that
/// the short-circuit is real at runtime.
/// </summary>
public class Adr0151IfLetExpressionEmitTests
{
    [Fact]
    public void IfLetExpression_InLetInit_ProducesValue()
    {
        var source = """
            package Test
            import System

            func Run(s string?) string {
                return if let v = s { v } else { "none" }
            }

            let a = Run("hi")
            let b = Run(nil)
            Console.WriteLine(a)
            Console.WriteLine(b)
            """;

        Assert.Equal($"hi{Environment.NewLine}none{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_WithGuard()
    {
        var source = """
            package Test
            import System

            func Run(s string?) string {
                return if let v = s && v.Length > 3 { v } else { "short" }
            }

            Console.WriteLine(Run("hi"))
            Console.WriteLine(Run("hello"))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"short{Environment.NewLine}hello{Environment.NewLine}short{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_AsCallArgument()
    {
        var source = """
            package Test
            import System

            func Get() string? {
                return "arg"
            }

            Console.WriteLine(if let v = Get() { v } else { "none" })
            """;

        Assert.Equal($"arg{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_InExpressionBodiedMember()
    {
        var source = """
            package Test
            import System

            class Holder {
                var items []?string

                prop First string? -> if let all = items && all.Length > 0 { all[0] } else { default(string?) }
            }

            let h = Holder()
            h.items = []string{"first", "second"}
            Console.WriteLine(h.First ?? "none")

            let empty = Holder()
            Console.WriteLine(empty.First ?? "none")
            """;

        Assert.Equal($"first{Environment.NewLine}none{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_EvaluatesInitializerExactlyOnce()
    {
        var source = """
            package Test
            import System

            var calls = 0
            func Source() string? {
                calls = calls + 1
                return "x"
            }

            let v = if let s = Source() { s } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(calls)
            """;

        Assert.Equal($"x{Environment.NewLine}1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_ShortCircuits_LaterInitializerAndGuard()
    {
        var source = """
            package Test
            import System

            var secondCalls = 0
            var guardCalls = 0

            func First() string? {
                return nil
            }

            func Second() string? {
                secondCalls = secondCalls + 1
                return "b"
            }

            func Check() bool {
                guardCalls = guardCalls + 1
                return true
            }

            let v = if let a = First(), let b = Second() && Check() { b } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(secondCalls)
            Console.WriteLine(guardCalls)
            """;

        Assert.Equal($"none{Environment.NewLine}0{Environment.NewLine}0{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_MultipleBindings_LeftToRightAndVisibleToLaterInitializers()
    {
        var source = """
            package Test
            import System

            var log = ""

            func A() string? {
                log = log + "a"
                return "A"
            }

            func B(seed string) string? {
                log = log + "b"
                return seed + "B"
            }

            let v = if let x = A(), let y = B(x) { y } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(log)
            """;

        Assert.Equal($"AB{Environment.NewLine}ab{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_NullableValueTypeBinding()
    {
        var source = """
            package Test
            import System

            func Run(n int32?) int32 {
                return if let v = n && v > 0 { v } else { -1 }
            }

            Console.WriteLine(Run(3))
            Console.WriteLine(Run(-3))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"3{Environment.NewLine}-1{Environment.NewLine}-1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_ElseIfLetChain()
    {
        var source = """
            package Test
            import System

            func Run(a string?, b string?) string {
                return if let x = a { x } else if let y = b { y } else { "none" }
            }

            Console.WriteLine(Run("a", "b"))
            Console.WriteLine(Run(nil, "b"))
            Console.WriteLine(Run(nil, nil))
            """;

        Assert.Equal($"a{Environment.NewLine}b{Environment.NewLine}none{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_NestedInsideIfExpressionBranch()
    {
        var source = """
            package Test
            import System

            func Run(flag bool, a string?) string {
                return if flag {
                    if let x = a { x } else { "inner" }
                } else {
                    "outer"
                }
            }

            Console.WriteLine(Run(true, "hit"))
            Console.WriteLine(Run(true, nil))
            Console.WriteLine(Run(false, "hit"))
            """;

        Assert.Equal($"hit{Environment.NewLine}inner{Environment.NewLine}outer{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetExpression_BlockPrefixStatementsRunBeforeTheTail()
    {
        var source = """
            package Test
            import System

            func Run(s string?) int32 {
                return if let v = s {
                    let n = v.Length
                    n + 1
                } else {
                    0
                }
            }

            Console.WriteLine(Run("abc"))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"4{Environment.NewLine}0{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void IfLetStatement_StillEmitsUnchanged()
    {
        // Regression guard: the ADR-0071 statement form is untouched.
        var source = """
            package Test
            import System

            func Run(s string?) int32 {
                if let v = s {
                    return v.Length
                } else {
                    return -1
                }
            }

            Console.WriteLine(Run("abcd"))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"4{Environment.NewLine}-1{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0151_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
