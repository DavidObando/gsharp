// <copyright file="Issue762MarshalAsInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for ADR-0096 / issue #762 — per-parameter
/// <c>@MarshalAs(UnmanagedType.…)</c> overrides on P/Invoke
/// declarations. The interpreter delegates the actual unmanaged
/// marshalling to the CLR at the P/Invoke transition (the binder
/// attaches the metadata; the runtime stub honours it). The crucial
/// guarantees in the interpreter are (a) the accepted shapes parse,
/// bind, and submit without crashing the REPL, and (b) the new binder
/// diagnostics (GS0357–GS0360) surface through the REPL when the user
/// mis-uses the shape. End-to-end native callbacks live in
/// <c>Issue762MarshalAsEmitTests</c>.
/// </summary>
public class Issue762MarshalAsInterpreterTests
{
    [Fact]
    public void MarshalAs_LPWStr_OnString_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("user32", EntryPoint: "MessageBoxW")
            func MessageBoxW(
                hWnd nint,
                @MarshalAs(UnmanagedType.LPWStr) lpText string,
                @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
                uType uint32) int32;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("GS0357", output);
        Assert.DoesNotContain("GS0358", output);
        Assert.DoesNotContain("GS0359", output);
        Assert.DoesNotContain("GS0360", output);
    }

    [Fact]
    public void MarshalAs_I4_OnBool_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libfoo", EntryPoint: "set_flag")
            func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("GS0358", output);
    }

    [Fact]
    public void MarshalAs_LPArray_WithSizeParamIndex_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libfoo", EntryPoint: "sum_buf")
            func native_sum_buf(
                @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
                count int32) int64;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("GS0359", output);
    }

    [Fact]
    public void MarshalAs_UnsupportedUnmanagedType_ReportsGS0357InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libfoo", EntryPoint: "x")
            func native_x(@MarshalAs(UnmanagedType.CustomMarshaler) p int32) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0357", output);
    }

    [Fact]
    public void MarshalAs_LPWStr_OnInt_ReportsGS0358InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libfoo", EntryPoint: "x")
            func native_x(@MarshalAs(UnmanagedType.LPWStr) p int32) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0358", output);
    }

    [Fact]
    public void MarshalAs_ByValTStr_WithoutSizeConst_ReportsGS0359InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libfoo", EntryPoint: "x")
            func native_x(@MarshalAs(UnmanagedType.ByValTStr) s string) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0359", output);
    }

    [Fact]
    public void MarshalAs_OnLibraryImportString_ReportsGS0360InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libfoo", EntryPoint: "x", StringMarshalling: StringMarshalling.Utf16)
            func native_x(@MarshalAs(UnmanagedType.LPWStr) s string) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0360", output);
    }

    [Fact]
    public void MarshalAs_OnNonPInvokeFunction_ReportsGS0360InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            func managed(@MarshalAs(UnmanagedType.LPWStr) s string) void {
            }

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0360", output);
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
