// <copyright file="Issue761PInvokeFunctionPointerInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for ADR-0095 / issue #761 — P/Invoke
/// function-pointer marshalling. The interpreter has no managed-IL emit
/// pipeline, so it cannot actually transition to native code; instead it
/// walks the bound tree and runs P/Invoke declarations through the same
/// empty-body path that the binder reserves for <c>@DllImport</c> /
/// <c>@LibraryImport</c>. The crucial guarantees in the interpreter are
/// (a) the new function-pointer / delegate-callback shapes parse, bind,
/// and submit without crashing the REPL, and (b) the binder diagnostics
/// (GS0353–GS0356) surface through the REPL when the user mis-uses the
/// shape. End-to-end native callbacks live in
/// <c>Issue761PInvokeFunctionPointerEmitTests</c>.
/// </summary>
public class Issue761PInvokeFunctionPointerInterpreterTests
{
    [Fact]
    public void DllImport_RawFunctionPointer_Parameter_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("GS0353", output);
        Assert.DoesNotContain("GS0354", output);
        Assert.DoesNotContain("GS0355", output);
        Assert.DoesNotContain("GS0356", output);
    }

    [Fact]
    public void DllImport_DelegateWithUnmanagedFunctionPointer_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @UnmanagedFunctionPointer(CallingConvention.Cdecl)
            type Comparer = delegate func(a nint, b nint) int32

            @DllImport("libc", EntryPoint: "qsort")
            func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("GS0353", output);
    }

    [Fact]
    public void DllImport_DelegateWithoutUnmanagedFunctionPointer_ReportsGS0353InRepl()
    {
        var source = """
            import System.Runtime.InteropServices

            type Comparer = delegate func(a nint, b nint) int32

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
            type Callback = delegate func() void

            @DllImport("libc", EntryPoint: "f")
            func bad() Callback;

            Console.WriteLine("unreachable")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0355", output);
    }

    [Fact]
    public void DllImport_FunctionPointer_ReturnType_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "dlsym")
            func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;

            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
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
