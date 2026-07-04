// <copyright file="Issue2026GenericAsyncTaskWrapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2026: calling a generic <c>async func</c> from inside another
/// generic function must observe the call's result type as <c>Task[U]</c> (the
/// substituted return type, Task-wrapped) — not the raw substituted return
/// type <c>U</c> — so <c>await</c> on the result is legal. Before this fix,
/// <c>gsc</c> reported GS0133 ("cannot be awaited") for this shape.
/// </summary>
/// <remarks>
/// A full compile-AND-RUN round trip of the exact issue repro used to be
/// blocked by two separate, pre-existing emit-layer gaps tracked in
/// https://github.com/DavidObando/gsharp/issues/2030: (1) state-machine
/// synthesis reported GS0190 whenever the declared inner return type was an
/// open type parameter, and (2) hoisting a generic-typed parameter/local into
/// the state machine crashed at runtime with <see cref="BadImageFormatException"/>.
/// Both gaps are now fixed — these tests exercise the full compile-and-run
/// round trip rather than only pinning the binder-level GS0133 fix.
/// </remarks>
public class Issue2026GenericAsyncTaskWrapEmitTests
{
    [Fact]
    public void GenericAsyncFunctionCall_InsideAnotherGeneric_CompilesAndRuns()
    {
        var source = """
            package P
            async func Foo[U](x U) U {
                return x
            }
            async func Outer[U](seed U) U {
                var r = Foo(seed)
                return await r
            }
            var t = Outer("hi")
            t.Wait()
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void NonGenericAsyncFunctionCall_InsideGenericCaller_CompilesAndRuns()
    {
        // Issue #2030 gap 2 repro: a generic async caller hoisting its own
        // type-parameter-typed parameter (`seed U`) into the state machine,
        // even though the declared return type (`int32`) is concrete.
        var source = """
            package P
            async func Answer() int32 {
                return 42
            }
            async func Outer[U](seed U) int32 {
                var r = Answer()
                return await r
            }
            var t = Outer("hi")
            t.Wait()
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2026_").FullName;
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
            IlVerifier.Verify(outPath);
            Assert.True(File.Exists(outPath), $"expected emitted assembly at {outPath}");

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
