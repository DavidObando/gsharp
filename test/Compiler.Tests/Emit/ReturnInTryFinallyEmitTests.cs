// <copyright file="ReturnInTryFinallyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #419 (P0-2): a <c>return</c> statement lexically inside a
/// <c>try</c> / <c>catch</c> / <c>finally</c> region used to be emitted as a
/// plain CIL <c>ret</c>, which is rejected by the runtime with
/// <c>InvalidProgramException</c> (ECMA-335 forbids <c>ret</c> from inside a
/// protected region — the only legal exit is <c>leave</c>). The Lowerer now
/// rewrites such returns into a store-to-temp + goto-exit pair so the emitter
/// produces a <c>leave</c>, runs the enclosing finally handlers, then reloads
/// the temp and emits the single <c>ret</c> at the synthesized method-exit.
/// These tests compile and execute small G# programs end-to-end and assert the
/// final stdout to verify both the returned value AND the finally side-effect.
/// </summary>
public class ReturnInTryFinallyEmitTests
{
    [Fact]
    public void Return_From_Try_With_Finally_Returns_Value_And_Runs_Finally()
    {
        var src = """
            package main
            import System

            func compute() int32 {
                try {
                    return 7
                } finally {
                    Console.WriteLine("finally ran")
                }
                return 0
            }

            func Main() int32 {
                let v = compute()
                Console.WriteLine(v)
                return 0
            }
            """;

        Assert.Equal("finally ran\n7\n", CompileAndRun(src));
    }

    [Fact]
    public void Return_From_Catch_Block_Returns_Value_And_Runs_Finally()
    {
        var src = """
            package main
            import System

            func compute() int32 {
                try {
                    throw Exception("boom")
                } catch (e Exception) {
                    return 42
                } finally {
                    Console.WriteLine("finally ran")
                }
                return 0
            }

            func Main() int32 {
                let v = compute()
                Console.WriteLine(v)
                return 0
            }
            """;

        Assert.Equal("finally ran\n42\n", CompileAndRun(src));
    }

    [Fact]
    public void Return_From_Nested_Try_Finally_Runs_All_Finallies_In_Order()
    {
        var src = """
            package main
            import System

            func compute() int32 {
                try {
                    try {
                        return 100
                    } finally {
                        Console.WriteLine("inner finally")
                    }
                } finally {
                    Console.WriteLine("outer finally")
                }
                return 0
            }

            func Main() int32 {
                let v = compute()
                Console.WriteLine(v)
                return 0
            }
            """;

        Assert.Equal("inner finally\nouter finally\n100\n", CompileAndRun(src));
    }

    [Fact]
    public void Void_Returning_Function_With_Return_Inside_Try_Finally_Runs_Finally()
    {
        var src = """
            package main
            import System

            func work() {
                try {
                    Console.WriteLine("before return")
                    return
                } finally {
                    Console.WriteLine("finally ran")
                }
                Console.WriteLine("unreachable")
            }

            func Main() int32 {
                work()
                Console.WriteLine("done")
                return 0
            }
            """;

        Assert.Equal("before return\nfinally ran\ndone\n", CompileAndRun(src));
    }

    [Fact]
    public void Multiple_Returns_Inside_Try_Finally_All_Route_Through_Exit()
    {
        var src = """
            package main
            import System

            func pick(b bool) int32 {
                try {
                    if b {
                        return 1
                    }
                    return 2
                } finally {
                    Console.WriteLine("finally ran")
                }
                return 0
            }

            func Main() int32 {
                Console.WriteLine(pick(true))
                Console.WriteLine(pick(false))
                return 0
            }
            """;

        Assert.Equal("finally ran\n1\nfinally ran\n2\n", CompileAndRun(src));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_p0_2_ret_try_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); }
            catch { }
        }
    }
}
