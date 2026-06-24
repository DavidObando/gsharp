// <copyright file="Issue1034StructPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1034 / ADR-0122 §4: end-to-end emit + execution tests for unmanaged
/// pointers to blittable user structs (<c>*S</c>). Each test compiles via
/// <c>gsc</c> and executes the produced assembly under <c>dotnet exec</c>,
/// covering deref/index read+write (<c>ldobj</c>/<c>stobj</c>), arithmetic and
/// pointer difference scaled by the emitted <c>sizeof S</c>, member access
/// through the pointer (<c>(*p).field</c> and <c>p-&gt;field</c>), and a
/// round-trip through <c>nint</c>.
/// <para>
/// Genuinely-unsafe pointer code is unverifiable by design; the inherent
/// error codes are passed to <c>ignoredErrorCodes</c> so the gate still
/// catches new unrelated verification regressions (including invalid
/// <c>ldobj</c>/<c>stobj</c>/<c>sizeof</c> tokens) while asserting runtime
/// behavior.
/// </para>
/// </summary>
public class Issue1034StructPointerEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    private const string PointStruct = """
        package Probe
        import System
        import System.Runtime.InteropServices

        @StructLayout(LayoutKind.Sequential)
        struct Point {
            var x int32
            var y int32
        }

        """;

    [Fact]
    public void StructPointer_DerefReadWrite_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}}
                var p = &arr[0]
                *p = Point{x: 10, y: 20}
                var v = *p
                Console.WriteLine(v.x)
                Console.WriteLine(v.y)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n", output);
    }

    [Fact]
    public void StructPointer_MemberAccess_DerefAndArrow_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1, y: 2}}
                var p = &arr[0]
                p->x = 11
                (*p).y = 22
                Console.WriteLine(p->x)
                Console.WriteLine((*p).y)
                Console.WriteLine(arr[0].x)
                Console.WriteLine(arr[0].y)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n22\n11\n22\n", output);
    }

    [Fact]
    public void StructPointer_IndexingReadWrite_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}, Point{x: 5, y: 6}}
                var p = &arr[0]
                Console.WriteLine(p[2].x)
                p[1] = Point{x: 33, y: 44}
                Console.WriteLine(arr[1].x)
                Console.WriteLine(arr[1].y)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n33\n44\n", output);
    }

    [Fact]
    public void StructPointer_ArithmeticAndDifference_ScaledBySizeof_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}, Point{x: 5, y: 6}, Point{x: 7, y: 8}}
                var p = &arr[0]
                var q = p + 3
                Console.WriteLine((*q).x)
                var r = q - 1
                Console.WriteLine((*r).x)
                var d = q - p
                Console.WriteLine(d)
                Console.WriteLine(p - q)
            }

            run()
            """;

        var output = CompileAndRun(source);

        // q = p + 3 -> arr[3].x == 7; r = q - 1 -> arr[2].x == 5;
        // q - p == 3 and p - q == -3 (scaled by sizeof(Point) == 8 bytes).
        Assert.Equal("7\n5\n3\n-3\n", output);
    }

    [Fact]
    public void StructPointer_NintRoundTrip_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}}
                var p = &arr[0]
                var addr = nint(p)
                var q = *Point(addr)
                q->x = 99
                Console.WriteLine(arr[0].x)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1034_").FullName;
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
