// <copyright file="Issue523ClosureCaptureByRefTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression coverage for issue #523: function literals must capture their
/// enclosing locals/parameters by reference (over the variable cell), not
/// by value at literal-construction time. Each test compiles an end-to-end
/// program, runs it with <c>dotnet exec</c>, runs <c>ilverify</c> against
/// the emitted assembly, and asserts on stdout.
/// </summary>
public class Issue523ClosureCaptureByRefTests
{
    /// <summary>
    /// The exact repro from the issue body: a captured value-type local that
    /// is reassigned after the lambda is constructed must be visible to the
    /// lambda body.
    /// </summary>
    [Fact]
    public void IssueRepro_ValueTypeLocal_LambdaSeesPostConstructionWrite()
    {
        var source = """
            package P
            import System

            func probe() {
                var n = 1
                var getter = func() int32 { return n }
                n = 99
                Console.WriteLine(getter())
            }

            probe()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void TwoLambdasShareCapturedCell()
    {
        var source = """
            package P
            import System

            func main2() {
                var n = 1
                var read = func() int32 { return n }
                var write = func(x int32) { n = x }
                Console.WriteLine(read())
                write(42)
                Console.WriteLine(read())
                n = 7
                Console.WriteLine(read())
            }

            main2()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n42\n7\n", output);
    }

    [Fact]
    public void CapturedParameter_LambdaObservesOuterWrites()
    {
        var source = """
            package P
            import System

            func makeCounter(start int32) func() int32 {
                var n = start
                var inc = func() int32 {
                    n = n + 1
                    return n
                }
                // Pre-bump the param-derived local: the lambda must see the
                // update because both this scope and the lambda share the
                // same cell.
                n = n + 10
                return inc
            }

            var c = makeCounter(0)
            Console.WriteLine(c())
            Console.WriteLine(c())
            Console.WriteLine(c())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n12\n13\n", output);
    }

    [Fact]
    public void NestedLambda_InnerSeesOuterReassignment()
    {
        var source = """
            package P
            import System

            func make() func() func() int32 {
                var n = 0
                var outer = func() func() int32 {
                    var inner = func() int32 { return n }
                    return inner
                }
                n = 5
                return outer
            }

            var g = make()
            var f = g()
            Console.WriteLine(f())
            """;

        var output = CompileAndRun(source);
        // n is shared through the box; the inner lambda is built when outer
        // runs, but it still resolves n through the same cell that the
        // outermost write `n = 5` touched.
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void CaptureSurvivesAcrossCallBoundary_LambdaMutatesAfterRoundTrip()
    {
        var source = """
            package P
            import System

            func bumpTwice(f func()) {
                f()
                f()
            }

            func main3() {
                var n = 10
                var inc = func() { n = n + 1 }
                bumpTwice(inc)
                bumpTwice(inc)
                Console.WriteLine(n)
            }

            main3()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("14\n", output);
    }

    [Fact]
    public void BoolCapture_LambdaSeesFlip()
    {
        var source = """
            package P
            import System

            func main4() {
                var flag = false
                var read = func() bool { return flag }
                Console.WriteLine(read())
                flag = true
                Console.WriteLine(read())
            }

            main4()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\nTrue\n", output);
    }

    [Fact]
    public void ReferenceTypeCapture_LambdaSeesReassignment()
    {
        var source = """
            package P
            import System
            import System.Text

            func main5() {
                var sb = StringBuilder()
                sb.Append("first")
                var read = func() string { return sb.ToString() }
                Console.WriteLine(read())
                sb = StringBuilder()
                sb.Append("second")
                Console.WriteLine(read())
            }

            main5()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("first\nsecond\n", output);
    }

    [Fact]
    public void CapturedLocalInsideLoop_FreshCellPerIteration()
    {
        // Each iteration of a `for…in` body re-runs the inner `var`
        // declaration, so the box allocation runs per-iteration — matching
        // C# semantics for a variable declared inside a loop body. Capture
        // two lambdas from successive iterations and verify each carries
        // its own cell.
        var source = """
            package P
            import System

            type Holder class {
                public var First func() int32
                public var Second func() int32
                init() {}
            }

            func main6() {
                var h = Holder()
                for i in []int32{0, 1} {
                    var n = i
                    var f = func() int32 { return n }
                    if i == 0 {
                        h.First = f
                    } else {
                        h.Second = f
                    }
                }
                var a = h.First
                var b = h.Second
                Console.WriteLine(a())
                Console.WriteLine(b())
            }

            main6()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n1\n", output);
    }

    [Fact]
    public void GlobalVar_ReadsLiveValueFromStaticField()
    {
        // Issue #523 (side fix): globals are addressable as static fields,
        // so the lambda must read them live (ldsfld) rather than snapshot
        // them into a closure field at literal-construction time.
        var source = """
            package P
            import System

            var g = 1

            func makeReader() func() int32 {
                return func() int32 { return g }
            }

            var r = makeReader()
            Console.WriteLine(r())
            g = 99
            Console.WriteLine(r())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_523_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
