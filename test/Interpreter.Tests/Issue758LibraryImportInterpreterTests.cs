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
/// The interpreter has no native-call transition, so calls report the
/// intentional GS0514 boundary and direct users to <c>gsc /out:</c>.
/// Binder diagnostics for invalid declarations still take precedence.
/// </summary>
public class Issue758LibraryImportInterpreterTests
{
    [Fact]
    public void LibraryImport_WithoutStringArgs_ReportsGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getpid")
            func getpid_native() int32;

            var pid = getpid_native()
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0514", output);
        Assert.DoesNotContain("ran", output);
    }

    [Fact]
    public void LibraryImport_WithStringArg_ReportsGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
            func strlen_native(text string) nint;

            var n = strlen_native("Hello")
            Console.WriteLine("ran")
            """;

        var output = RunSubmission(source);
        Assert.Contains("GS0514", output);
        Assert.DoesNotContain("ran", output);
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
