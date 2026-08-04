// <copyright file="Issue758LibraryImportInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0092 / issue #758: coverage for the <c>@LibraryImport</c>
/// source-generator-shaped P/Invoke attribute in the REPL. The GS0514
/// interpreter boundary pins retired with the tree-walking evaluator
/// (ADR-0156 Phase 3c, #3176) — P/Invoke runs natively on the emitted
/// engine, with positive native-call coverage in the PInvoke* conformance
/// samples. Binder diagnostics for invalid declarations remain.
/// </summary>
public class Issue758LibraryImportInterpreterTests
{
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
