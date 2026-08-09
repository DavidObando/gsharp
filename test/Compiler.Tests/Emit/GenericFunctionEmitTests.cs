// <copyright file="GenericFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit coverage for generic function.
/// Traceability: ADR-0004.
/// </summary>
public class GenericFunctionEmitTests
{
    [Fact]
    public void GenericIdentity_InferredInt()
    {
        var source = """
            package P
            import System

            func Identity[T any](x T) T { return x }
            Console.WriteLine(Identity(42))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"42{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericIdentity_ExplicitString()
    {
        var source = """
            package P
            import System

            func Identity[T any](x T) T { return x }
            Console.WriteLine(Identity[string]("hi"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericIdentity_InferredBool()
    {
        var source = """
            package P
            import System

            func Identity[T any](x T) T { return x }
            Console.WriteLine(Identity(true))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericTwoParameters_FirstWins()
    {
        var source = """
            package P
            import System

            func First[T any, U any](a T, b U) T { return a }
            Console.WriteLine(First(10, "ignored"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"10{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericTwoParameters_SecondWins()
    {
        var source = """
            package P
            import System

            func Second[T any, U any](a T, b U) U { return b }
            Console.WriteLine(Second("ignored", 99))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"99{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericRoundTrip_StoredAndReused()
    {
        // Substituted return is int; the call site unboxes, the assignment
        // stores into an int-typed local, and arithmetic on it works.
        var source = """
            package P
            import System

            func Identity[T any](x T) T { return x }

            var n = Identity(20)
            Console.WriteLine(n + 22)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"42{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericVoidDelegate_DynamicInvoke_PopsResult_Issue418()
    {
        // Issue #418 (P1-6): an erased void-returning delegate (func(T) with
        // no return) is invoked via System.Delegate.DynamicInvoke which always
        // returns object. Without an explicit Pop the boxed result lingers on
        // the stack until the next ret/leave, producing invalid IL that
        // refuses to load.
        var source = """
            package P
            import System

            func Run[T any](x T, f func(T)) { f(x) }
            Run(7, func(n int32) { Console.WriteLine(n) })
            Run("hi", func(s string) { Console.WriteLine(s) })
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"7{Environment.NewLine}hi{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericVoidDelegate_DynamicInvoke_CalledInLoop_Issue418()
    {
        // Repeated invocation makes the stack-leak bug deterministic: each
        // iteration would push an object that survives across the back-edge.
        var source = """
            package P
            import System

            func Repeat[T any](x T, n int32, f func(T)) {
                for var i = 0; i < n; i = i + 1 {
                    f(x)
                }
            }
            Repeat(42, 3, func(v int32) { Console.WriteLine(v) })
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"42{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_generic_emit_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
