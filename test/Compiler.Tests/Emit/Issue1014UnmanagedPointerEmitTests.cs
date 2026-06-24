// <copyright file="Issue1014UnmanagedPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1014 / ADR-0122: end-to-end emit + execution tests for unmanaged
/// raw pointers (CLR <c>ELEMENT_TYPE_PTR</c>, C# <c>T*</c>) inside an
/// <c>unsafe</c> context. Each test compiles via <c>gsc</c> and executes the
/// produced assembly under <c>dotnet exec</c> to assert runtime behavior.
/// <para>
/// Genuinely-unsafe pointer code is <em>unverifiable by design</em>: ilverify
/// reports <c>UnmanagedPointer</c>, <c>StackUnexpected</c>, and
/// <c>StackByRef</c> for raw pointer manipulation and address-of of array
/// elements. Those specific codes are passed to <c>ignoredErrorCodes</c> so
/// the gate still catches any NEW unrelated verification regressions while
/// tolerating the inherent unsafety, rather than skipping ilverify globally.
/// </para>
/// </summary>
public class Issue1014UnmanagedPointerEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    [Fact]
    public void Pointer_DerefReadWrite_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{10, 20, 30}
                var p = &arr[0]
                *p = 99
                Console.WriteLine(*p)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n99\n", output);
    }

    [Fact]
    public void Pointer_IndexingReadWrite_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{1, 2, 3, 4}
                var p = &arr[0]
                Console.WriteLine(p[2])
                p[3] = 77
                Console.WriteLine(arr[3])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n77\n", output);
    }

    [Fact]
    public void Pointer_Arithmetic_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{5, 6, 7, 8}
                var p = &arr[0]
                var q = p + 2
                Console.WriteLine(*q)
                var r = q - 1
                Console.WriteLine(*r)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n6\n", output);
    }

    [Fact]
    public void Pointer_CastBetweenPointerTypes_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{42, 0, 0, 0}
                var p = &arr[0]
                var bp = *uint8(p)
                Console.WriteLine(bp[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Pointer_NintRoundTrip_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{123, 0}
                var p = &arr[0]
                var addr = nint(p)
                var p2 = *int32(addr)
                Console.WriteLine(*p2)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n", output);
    }

    [Fact]
    public void Pointer_Comparison_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var arr = []int32{1, 2}
                var p = &arr[0]
                var q = p
                Console.WriteLine(p == q)
                var r = p + 1
                Console.WriteLine(p != r)
                Console.WriteLine(p < r)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\nTrue\n", output);
    }

    [Fact]
    public void Pointer_NullPointer_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func run() {
                var np *int32 = nil
                Console.WriteLine(np == nil)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Pointer_FieldOnUnsafeType_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe class Holder {
                var buf *int32
                init(p *int32) {
                    buf = p
                }
                func first() int32 {
                    return *buf
                }
            }

            unsafe func run() {
                var arr = []int32{55, 66}
                var h = Holder(&arr[0])
                Console.WriteLine(h.first())
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("55\n", output);
    }

    [Fact]
    public void Pointer_PlainParameter_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            unsafe func writeThrough(p *int32, value int32) {
                *p = value
            }

            unsafe func run() {
                var arr = []int32{0, 0}
                writeThrough(&arr[0], 88)
                Console.WriteLine(arr[0])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("88\n", output);
    }

    [Fact]
    public void Pointer_UnsafeBlock_CompilesAndRuns()
    {
        var source = """
            package Probe
            import System

            func run() {
                var arr = []int32{7, 8, 9}
                unsafe {
                    var p = &arr[1]
                    *p = 100
                }
                Console.WriteLine(arr[1])
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1014_").FullName;
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

            // Unsafe pointer code is unverifiable by design; tolerate the
            // inherent-unsafety error codes while still gating on other
            // verification regressions.
            IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);

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
