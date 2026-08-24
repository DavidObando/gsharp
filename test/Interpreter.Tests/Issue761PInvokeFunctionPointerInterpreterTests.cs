// <copyright file="Issue761PInvokeFunctionPointerInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Coverage for ADR-0095 / issue #761 — P/Invoke function-pointer
/// marshalling in the REPL. The GS0514 interpreter boundary pins retired
/// with the tree-walking evaluator (ADR-0156 Phase 3c, #3176); binder
/// diagnostics (GS0353–GS0356) for invalid declarations remain.
/// </summary>
public class Issue761PInvokeFunctionPointerInterpreterTests
{
    [Fact]
    public void DllImport_DelegateWithoutUnmanagedFunctionPointer_ReportsGS0353InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            delegate Comparer(a nint, b nint) int32;

            @DllImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0353", output);
    }

    [Fact]
    public void DllImport_DelegateReturn_ReportsGS0355InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @UnmanagedFunctionPointer(CallingConvention.Cdecl)
            delegate Callback() void;

            @DllImport("libc", EntryPoint: "f")
            func bad() Callback;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0355", output);
    }

    [Fact]
    public void DllImport_UnknownCallingConvention_ReportsGS0354InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc")
            func bad(cb unmanaged[Garbage] () -> void) void;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0354", output);
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
