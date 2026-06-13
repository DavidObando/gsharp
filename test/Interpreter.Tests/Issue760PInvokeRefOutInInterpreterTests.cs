// <copyright file="Issue760PInvokeRefOutInInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for ADR-0094 / issue #760 — P/Invoke
/// <c>ref</c>/<c>out</c>/<c>in</c> parameter marshalling. The interpreter
/// has no managed-IL emit pipeline, so it cannot actually transition to
/// native code; instead it walks the bound tree and runs P/Invoke
/// functions through the same empty-body path the binder reserves for
/// <c>@DllImport</c> / <c>@LibraryImport</c>. The crucial guarantees are
/// (a) the program parses, binds, and runs without diagnostics or
/// crashes, and (b) the bound model accepts ref/out/in on P/Invoke
/// declarations (no GS0326 / GS0352 escapes when the pointee is
/// blittable). Programs that need to actually invoke native code must
/// use the compiler (<c>gsc</c>) — covered end-to-end by
/// <c>Issue760PInvokeRefOutInEmitTests</c>.
/// </summary>
public class Issue760PInvokeRefOutInInterpreterTests
{
    [Fact]
    public void DllImport_RefInt64_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;

            var t = 0L
            var rc = native_time(ref t)
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("GS0326", output);
        Assert.DoesNotContain("GS0352", output);
    }

    [Fact]
    public void DllImport_OutInt32_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "native_out")
            func native_out(out p int32) int32;

            var p = 0
            var rc = native_out(out p)
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LibraryImport_RefInt64_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "time")
            func native_time(ref t int64) int64;

            var t = 0L
            var rc = native_time(ref t)
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DllImport_RefBlittableStruct_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct TimeSpec {
                var tv_sec int64
                var tv_nsec int64
            }

            @DllImport("libc", EntryPoint: "clock_gettime")
            func clock_gettime_native(clk_id int32, ref tp TimeSpec) int32;

            var ts = TimeSpec{tv_sec: 0L, tv_nsec: 0L}
            var rc = clock_gettime_native(1, ref ts)
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DllImport_RefString_StillProducesBinderDiagnostic()
    {
        // GS0352 fires before the interpreter ever evaluates the submission.
        // The REPL renders diagnostics into stdout via WriteDiagnostics, so
        // the GS0352 code appears in the captured output stream.
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "native_str")
            func native_str(ref s string) int32;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0352", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
