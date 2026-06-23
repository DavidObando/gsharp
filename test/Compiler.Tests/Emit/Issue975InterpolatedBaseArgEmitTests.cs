// <copyright file="Issue975InterpolatedBaseArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #975: end-to-end emit tests proving that an interpolated string in a
/// <c>: base(...)</c> constructor-argument position is lowered like an ordinary
/// call argument instead of reaching the emitter as a raw
/// <c>BoundInterpolatedStringExpression</c> (which previously ICE'd with
/// <c>GS9998</c>). Each test compiles via <c>gsc</c>, runs <c>ilverify</c>, then
/// executes the produced assembly under <c>dotnet exec</c> to assert the
/// interpolation renders correctly at runtime.
/// </summary>
public class Issue975InterpolatedBaseArgEmitTests
{
    [Fact]
    public void InterpolatedMessage_ForwardedToBase_CompilesAndRuns()
    {
        // The exact repro from issue #975: a single-hole interpolated string
        // forwarded to the base Exception constructor.
        var source = """
            package Probe
            import System

            class E1 : Exception {
                init(n int32) : base("only $n left") {
                }
            }

            try {
                throw E1(3)
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("only 3 left\n", output);
    }

    [Fact]
    public void InterpolatedMessage_MultipleHolesAndFormatSpecifier_CompilesAndRuns()
    {
        // Multiple holes, an embedded expression hole, an alignment + format
        // specifier, all in base-initializer position.
        var source = """
            package Probe
            import System

            class E2 : Exception {
                init(n int32, who string) : base("$who has ${n:D3} items, next [${n + 1,4:X2}]") {
                }
            }

            try {
                throw E2(7, "bob")
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("bob has 007 items, next [  08]\n", output);
    }

    [Fact]
    public void LiteralAndConcatBaseArguments_StillCompileAndRun()
    {
        // Controls from the issue: a plain literal and a string-concat base
        // argument must keep compiling and rendering correctly.
        var source = """
            package Probe
            import System

            class E3 : Exception { init(n int32) : base("plain literal") { } }
            class E4 : Exception { init(n int32) : base("only " + n.ToString() + " left") { } }

            try {
                throw E3(1)
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            try {
                throw E4(9)
            } catch (e Exception) {
                Console.WriteLine(e.Message)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("plain literal\nonly 9 left\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue975_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
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
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
