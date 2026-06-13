// <copyright file="Issue758LibraryImportInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0092 / issue #758: interpreter coverage for the
/// <c>@LibraryImport</c> source-generator-shaped P/Invoke attribute.
/// The G# interpreter has no managed-IL emit pipeline, so it cannot
/// actually transition to native code; instead, it walks the bound
/// tree and runs <c>@LibraryImport</c> functions through the same
/// empty-body path that the binder reserves for any P/Invoke. The
/// program must still parse, bind, and run without diagnostics or
/// crashes. Once the function returns its default value, the rest of
/// the program continues normally. Programs that need to actually
/// invoke native code must use the compiler (<c>gsc</c>) and the
/// emitted CLR P/Invoke metadata; that path is covered end-to-end by
/// <c>Issue758LibraryImportEmitTests</c>.
/// </summary>
public class Issue758LibraryImportInterpreterTests
{
    [Fact]
    public void LibraryImport_WithoutStringArgs_DefaultReturn_DoesNotCrashInterpreter()
    {
        // The interpreter has no native-call infrastructure, so the
        // @LibraryImport function is treated as if it had an empty body
        // (the same path the binder reserves for @DllImport in the
        // interpreter). The function returns the default value for its
        // return type. The crucial guarantee is that the bound program
        // is well-formed and the interpreter does not throw.
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getpid")
            func getpid_native() int32;

            var pid = getpid_native()
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LibraryImport_WithStringArg_DefaultReturn_DoesNotCrashInterpreter()
    {
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
            func strlen_native(text string) nint;

            var n = strlen_native("Hello")
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("ran", output);
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LibraryImport_PoorlyTypedSurface_StillProducesBinderDiagnostics()
    {
        // GS0344: a string-bearing LibraryImport without StringMarshalling
        // is rejected by the binder before the interpreter ever evaluates
        // the submission. The REPL renders diagnostics into stdout via
        // WriteDiagnostics, so the GS0344 code appears in the captured
        // output stream.
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc")
            func strlen_native(text string) nint;

            Console.WriteLine(strlen_native("hi"))
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0344", output);
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
