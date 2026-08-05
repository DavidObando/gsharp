// <copyright file="Issue760PInvokeRefOutInInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Coverage for ADR-0094 / issue #760 — P/Invoke
/// <c>ref</c>/<c>out</c>/<c>in</c> parameter marshalling in the REPL. The
/// GS0514 interpreter boundary pins retired with the tree-walking evaluator
/// (ADR-0156 Phase 3c, #3176) — ref/out/in P/Invoke runs natively on the
/// emitted engine, with positive native-call coverage in the
/// PInvokeRefOutIn conformance sample. Binder diagnostics for invalid
/// declarations remain.
/// </summary>
public class Issue760PInvokeRefOutInInterpreterTests
{
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
