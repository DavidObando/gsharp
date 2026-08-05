// <copyright file="Issue762MarshalAsInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Coverage for ADR-0096 / issue #762 — per-parameter
/// <c>@MarshalAs(UnmanagedType.…)</c> overrides on P/Invoke declarations in
/// the REPL. The GS0514 interpreter boundary pins retired with the
/// tree-walking evaluator (ADR-0156 Phase 3c, #3176; positive native-call
/// coverage lives in the PInvokeMarshalAs conformance sample); binder
/// diagnostics (GS0357–GS0360) for invalid declarations remain.
/// </summary>
public class Issue762MarshalAsInterpreterTests
{
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
