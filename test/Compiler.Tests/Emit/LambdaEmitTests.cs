// <copyright file="LambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 emit-parity tests for function literals (Phase 4.7) — emit
/// commit E1: no-capture lambdas + indirect calls.
/// <para>
/// Each function literal is lowered to a synthesized static method on the
/// owning package's <c>&lt;Program&gt;</c> type, and the literal site emits
/// <c>ldnull / ldftn / newobj Func|Action::.ctor(object, IntPtr)</c>. An
/// indirect call evaluates the target delegate value and dispatches via
/// <c>callvirt Invoke</c>. Captures are explicitly not in scope for E1 —
/// see <see cref="ClosureCaptures_StillUnsupported"/>.
/// </para>
/// </summary>
public class LambdaEmitTests
{
    [Fact]
    public void FuncIntInt_AssignedAndInvoked()
    {
        var source = """
            package P
            import System

            var inc = func(x int) int { return x + 1 }
            Console.WriteLine(inc(10))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void ActionNoArgs_AssignedAndInvoked()
    {
        var source = """
            package P
            import System

            var greet = func() { Console.WriteLine("hi") }
            greet()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void FuncTwoArgs_AssignedAndInvoked()
    {
        var source = """
            package P
            import System

            var add = func(a int, b int) int { return a + b }
            Console.WriteLine(add(3, 4))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void IndirectCall_ThroughFunctionTypedParameter()
    {
        var source = """
            package P
            import System

            func apply(f func(int) int, x int) int { return f(x) }

            var dbl = func(x int) int { return x * 2 }
            Console.WriteLine(apply(dbl, 21))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ClosureCaptures_StillUnsupported()
    {
        // Phase 4 emit parity E2 (closures) is not yet implemented.
        // The emitter must surface a clear diagnostic rather than miscompile.
        var source = """
            package P
            import System

            func makeAdder(n int) func(int) int {
              return func(x int) int { return x + n }
            }

            var addN = makeAdder(5)
            Console.WriteLine(addN(10))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_lambda_emit_neg_").FullName;
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

            Assert.NotEqual(0, compileExit);
            var combined = compileOut.ToString() + compileErr.ToString();
            Assert.Contains("captures outer variables", combined);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_lambda_emit_").FullName;
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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

            using var proc = Process.Start(psi);
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
