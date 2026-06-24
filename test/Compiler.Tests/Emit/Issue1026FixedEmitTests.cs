// <copyright file="Issue1026FixedEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1026 / ADR-0125: end-to-end emit + execution tests for the
/// <c>fixed</c> statement (<c>fixed &lt;name&gt; *T = &lt;source&gt; { ... }</c>).
/// The statement pins a managed array/slice or string and binds an unmanaged
/// <c>*T</c> pointer to its first element, emitting a CLR <c>pinned</c> local
/// (mirroring C# <c>fixed (T* p = expr) { }</c>). Each test compiles via
/// <c>gsc</c> and executes the produced assembly under <c>dotnet exec</c> to
/// assert runtime behavior.
/// <para>
/// Code that pins a buffer and dereferences an unmanaged pointer is
/// <em>unverifiable by design</em>: ilverify reports the usual
/// unmanaged-pointer / by-ref codes at the pin and dereference sites. Those
/// specific codes are passed to <c>ignoredErrorCodes</c> so the gate still
/// catches NEW unrelated verification regressions while tolerating the
/// inherent unsafety, rather than skipping ilverify globally.
/// </para>
/// </summary>
public class Issue1026FixedEmitTests
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
    public void ArrayPin_WriteRead_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var buf = []uint8{uint8(0), uint8(0), uint8(0)}
                fixed pD *uint8 = buf {
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
    public void StringPin_ReadChars_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var total = 0
                fixed pC *uint16 = "ABC" {
                    for var i = 0; i < 3; i++ {
                        total = total + int32(pC[i])
                    }
                }
                Console.WriteLine(total)
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);

        // 'A'(65) + 'B'(66) + 'C'(67) = 198
        Assert.Equal("198\n", output);
    }

    [Fact]
    public void OahuPattern_FixedBytePointer_CompilesAndRuns()
    {
        // Equivalent of the Oahu case `fixed (byte* pD = destination)` where
        // `destination` is a `byte[]`: copy bytes through the pinned pointer.
        var source = """
            package Probe
            import System

            unsafe func copyByte(destination []uint8, value uint8) {
                fixed pD *uint8 = destination {
                    *pD = value
                }
            }

            unsafe func run() {
                var dst = []uint8{uint8(0), uint8(0)}
                copyByte(dst, uint8(42))
                Console.WriteLine(int32(dst[0]))
                Console.WriteLine(int32(dst[1]))
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);
        Assert.Equal("42\n0\n", output);
    }

    [Fact]
    public void EmptyArrayPin_NullPointer_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var buf = []uint8{}
                fixed pD *uint8 = buf {
                    Console.WriteLine(nint(pD))
                }
            }

            run()
            """;

        var output = CompileAndRun(source, FixedIlVerifyIgnored);
        Assert.Equal("0\n", output);
    }

    private static string CompileAndRun(string source, string[] ilVerifyIgnored)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1026_").FullName;
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
            // gating on other verification regressions.
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
