// <copyright file="Issue1024StackAllocEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1024 / ADR-0124: end-to-end emit + execution tests for the
/// <c>stackalloc T[n]</c> stack-allocation expression. The default (safe)
/// form yields a <c>System.Span&lt;T&gt;</c> over <c>localloc</c>'d memory and
/// requires no <c>unsafe</c> context; the pointer form yields the raw
/// <c>T*</c> inside an unsafe context. Each test compiles via <c>gsc</c> and
/// executes the produced assembly under <c>dotnet exec</c> to assert runtime
/// behavior.
/// <para>
/// Code containing <c>localloc</c> is <em>unverifiable by design</em>:
/// ilverify reports <c>Unverifiable</c> at the <c>localloc</c> site (and the
/// usual unmanaged-pointer codes for the raw-pointer form). Those specific
/// codes are passed to <c>ignoredErrorCodes</c> so the gate still catches NEW
/// unrelated verification regressions while tolerating the inherent unsafety,
/// rather than skipping ilverify globally.
/// </para>
/// </summary>
public class Issue1024StackAllocEmitTests
{
    private static readonly string[] SafeSpanIlVerifyIgnored =
    {
        "Unverifiable",
    };

    private static readonly string[] UnsafePointerIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void SafeSpan_WriteReadLength_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            func run() {
                var buf = stackalloc uint8[4]
                buf[0] = uint8(10)
                buf[1] = uint8(20)
                buf[2] = uint8(30)
                buf[3] = uint8(40)
                Console.WriteLine(buf.Length)
                Console.WriteLine(int32(buf[2]))
                var sum = 0
                for var i = 0; i < buf.Length; i++ {
                    sum = sum + int32(buf[i])
                }
                Console.WriteLine(sum)
            }

            run()
            """;

        var output = CompileAndRun(source, SafeSpanIlVerifyIgnored);
        Assert.Equal("4\n30\n100\n", output);
    }

    [Fact]
    public void SafeSpan_ZeroInitialized_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            func run() {
                var buf = stackalloc int32[4]
                Console.WriteLine(buf[0])
                Console.WriteLine(buf[3])
            }

            run()
            """;

        var output = CompileAndRun(source, SafeSpanIlVerifyIgnored);
        Assert.Equal("0\n0\n", output);
    }

    [Fact]
    public void SafeSpan_RuntimeLength_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            func fill(n int32) int32 {
                var buf = stackalloc int32[n]
                for var i = 0; i < buf.Length; i++ {
                    buf[i] = i * i
                }
                var sum = 0
                for var i = 0; i < buf.Length; i++ {
                    sum = sum + buf[i]
                }
                return sum
            }

            func run() {
                Console.WriteLine(fill(4))
            }

            run()
            """;

        var output = CompileAndRun(source, SafeSpanIlVerifyIgnored);

        // 0 + 1 + 4 + 9 = 14
        Assert.Equal("14\n", output);
    }

    [Fact]
    public void UnsafePointer_WriteRead_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var p *int32 = stackalloc int32[3]
                p[0] = 5
                p[1] = 6
                p[2] = 7
                Console.WriteLine(p[0])
                Console.WriteLine(p[1])
                Console.WriteLine(p[2])
            }

            run()
            """;

        var output = CompileAndRun(source, UnsafePointerIlVerifyIgnored);
        Assert.Equal("5\n6\n7\n", output);
    }

    [Fact]
    public void UnsafePointer_ZeroInitialized_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var z *int32 = stackalloc int32[4]
                Console.WriteLine(z[0])
                Console.WriteLine(z[3])
            }

            run()
            """;

        var output = CompileAndRun(source, UnsafePointerIlVerifyIgnored);
        Assert.Equal("0\n0\n", output);
    }

    private static string CompileAndRun(string source, string[] ilVerifyIgnored)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1024_").FullName;
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

            // localloc is unverifiable by design; tolerate the specific
            // localloc/unmanaged-pointer codes while still gating on other
            // verification regressions.
            IlVerifier.Verify(outPath, null, ilVerifyIgnored);

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
