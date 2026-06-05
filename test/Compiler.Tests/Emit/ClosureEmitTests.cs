// <copyright file="ClosureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 emit-parity tests for closures (Phase 4.7) — emit commit E2.
/// <para>
/// Each capture-bearing function literal is lowered to a synthesized
/// internal sealed CLR class with one public field per captured variable
/// and an instance <c>Invoke</c> method holding the rewritten body. The
/// literal site emits
/// <c>newobj ctor / (dup; &lt;load capture&gt;; stfld field)* / ldftn Invoke /
/// newobj Func|Action::.ctor(object, IntPtr)</c>.
/// </para>
/// <para>
/// Capture semantics are snapshot-by-value at literal evaluation time —
/// the same behavior the interpreter implements. Writes inside the lambda
/// mutate the closure's field only; the outer variable is unaffected.
/// </para>
/// </summary>
public class ClosureEmitTests
{
    [Fact]
    public void SingleIntCapture()
    {
        var source = """
            package P
            import System

            func makeAdder(n int32) func(int32) int32 {
              return func(x int32) int32 { return x + n }
            }

            var addN = makeAdder(7)
            Console.WriteLine(addN(35))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void MultipleCaptures()
    {
        var source = """
            package P
            import System

            func makeLinear(a int32, b int32) func(int32) int32 {
              return func(x int32) int32 { return a * x + b }
            }

            var f = makeLinear(3, 4)
            Console.WriteLine(f(10))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("34\n", output);
    }

    [Fact]
    public void StringCapture()
    {
        var source = """
            package P
            import System

            func makeGreeter(greeting string) func(string) string {
              return func(name string) string { return greeting + ", " + name + "!" }
            }

            var hello = makeGreeter("Hello")
            Console.WriteLine(hello("world"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Hello, world!\n", output);
    }

    [Fact]
    public void SnapshotByValue_MutationInLambdaDoesNotAffectOuter()
    {
        // Inside the lambda, `c = c + 1` updates the closure field, not the
        // outer variable. The outer `c` is unchanged after the calls; the
        // closure carries its own copy.
        var source = """
            package P
            import System

            func makeCounter(start int32) func(int32) int32 {
              var c = start
              return func(x int32) int32 {
                c = c + 1
                return x + c
              }
            }

            var addN = makeCounter(10)
            Console.WriteLine(addN(0))
            Console.WriteLine(addN(0))
            """;

        var output = CompileAndRun(source);
        // First call: closure-local c becomes 11, returns 11.
        // Second call: closure-local c becomes 12, returns 12.
        Assert.Equal("11\n12\n", output);
    }

    [Fact]
    public void CaptureAcrossSeparateCalls_AreIndependent()
    {
        var source = """
            package P
            import System

            func makeAdder(n int32) func(int32) int32 {
              return func(x int32) int32 { return x + n }
            }

            var add5 = makeAdder(5)
            var add100 = makeAdder(100)
            Console.WriteLine(add5(1))
            Console.WriteLine(add100(1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n101\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_closure_emit_").FullName;
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

            // Drop a minimal runtimeconfig so `dotnet exec` can host the .dll.
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
