// <copyright file="Issue1043FixedPinnableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1043 / ADR-0125: end-to-end emit + execution tests for pinning a
/// span-like source via <c>GetPinnableReference</c> in a <c>fixed</c> statement
/// (<c>fixed &lt;name&gt; *T = &lt;span&gt; { ... }</c>). The statement pins the
/// <c>T&amp;</c> returned by a public instance <c>ref T GetPinnableReference()</c>
/// (canonically <c>System.Span[T]</c> / <c>System.ReadOnlySpan[T]</c>) into a
/// <c>T&amp; pinned</c> local and derives an unmanaged <c>*T</c> pointer via
/// <c>conv.u</c>, mirroring C# <c>fixed (T* p = span)</c>.
/// <para>
/// The critical regression this guards is that
/// <c>ReadOnlySpan[T].GetPinnableReference()</c> has a <c>ref readonly T</c>
/// return carrying <c>modreq(System.Runtime.InteropServices.InAttribute)</c>; the
/// emitted MemberRef must reproduce that modreq exactly or the call fails at
/// runtime with <c>System.MissingMethodException</c>. Each test compiles via
/// <c>gsc</c>, ilverifies (tolerating the inherent unmanaged-pointer codes), and
/// executes under <c>dotnet exec</c> to assert runtime behavior.
/// </para>
/// </summary>
public class Issue1043FixedPinnableEmitTests
{
    private static readonly string[] FixedIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
        "ExpectedNumericType",
    };

    [Fact]
    public void SpanPin_WriteRead_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var buf = []uint8{uint8(0), uint8(0), uint8(0)}
                var sp Span[uint8] = buf
                fixed pD *uint8 = sp {
                    pD[0] = uint8(65)
                    pD[1] = uint8(66)
                    pD[2] = uint8(67)
                }
                Console.WriteLine(int32(buf[0]))
                Console.WriteLine(int32(buf[1]))
                Console.WriteLine(int32(buf[2]))
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);
        Assert.Equal("65\n66\n67\n", output);
    }

    [Fact]
    public void ReadOnlySpanPin_ReadThroughModreqRef_CompilesAndRuns()
    {
        // `ReadOnlySpan[T].GetPinnableReference()` returns `ref readonly T`
        // (a `modreq(InAttribute)` ref-return); reading through the pinned
        // pointer exercises the modreq-bearing MemberRef at runtime.
        var source = """
            package Probe
            import System

            unsafe func run() {
                var buf = []uint8{uint8(10), uint8(20), uint8(30)}
                var ros ReadOnlySpan[uint8] = buf
                var total = 0
                fixed pR *uint8 = ros {
                    for var i = 0; i < 3; i++ {
                        total = total + int32(pR[i])
                    }
                }
                Console.WriteLine(total)
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);

        // 10 + 20 + 30 = 60
        Assert.Equal("60\n", output);
    }

    [Fact]
    public void SpanPin_RoundTripThroughDerefWrite_CompilesAndRuns()
    {
        // Writes through the raw `*T` derived from the span pin must be visible
        // in the underlying backing array (the span aliases `buf`).
        var source = """
            package Probe
            import System

            unsafe func fill(buf []uint8, value uint8) {
                var sp Span[uint8] = buf
                fixed p *uint8 = sp {
                    *p = value
                }
            }

            unsafe func run() {
                var dst = []uint8{uint8(0), uint8(0)}
                fill(dst, uint8(42))
                Console.WriteLine(int32(dst[0]))
                Console.WriteLine(int32(dst[1]))
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);
        Assert.Equal("42\n0\n", output);
    }

    private static string CompileAndRun(string source, string[] ilVerifyIgnored)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1043_").FullName;
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

            // Pinning + unmanaged-pointer dereference is unverifiable by
            // design; tolerate the specific pointer/by-ref codes while still
            // gating on other verification regressions (incl. a malformed
            // GetPinnableReference modreq signature).
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
