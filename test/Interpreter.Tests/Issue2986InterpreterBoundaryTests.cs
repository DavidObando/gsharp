// <copyright file="Issue2986InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Repl;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2986: explicit interpreter native-call boundary (GS0514).
/// ADR-0156 Phase 3a: the interactive cells here pin the LEGACY tree-walking
/// evaluator engine, constructed explicitly as <see cref="SessionEngine"/> —
/// never the interactive default, which is now the emitted engine where
/// P/Invoke runs natively. These evaluator-pinned tests retire with the
/// deprecated <c>--engine evaluator</c> escape hatch in Phase 3c.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2986InterpreterBoundaryTests
{
    [Fact]
    public void PInvokeDeclaration_WithoutUse_IsAllowed()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine(33)
            """;
        var engine = new SessionEngine { CaptureConsole = true };

        var cell = engine.Evaluate(source, "pinvoke.gs");

        Assert.Empty(cell.Diagnostics);
        Assert.False(cell.HasError);
        Assert.Equal("33\n", cell.Output);
    }

    [Fact]
    public void PInvokeDirectCall_ReportsLocatedGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine(NativeStrLen("Hello"))
            """;
        var engine = new SessionEngine { CaptureConsole = true };

        var cell = engine.Evaluate(source, "pinvoke.gs");

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal("pinvoke.gs", diagnostic.Location.FileName);
        Assert.Equal(3, diagnostic.Location.StartLine);
        Assert.Contains("NativeStrLen", diagnostic.Message);
        Assert.Contains("'gsc /out:<path>'", diagnostic.Message);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Fact]
    public void PInvokeFunctionValue_ReportsGS0514InsteadOfEvaluatorFailure()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            let f = NativeStrLen
            Console.WriteLine(f("Hello"))
            """;

        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.DoesNotContain("IConvertible", diagnostic.Message);
        Assert.Contains("'gsc /out:<path>'", diagnostic.Message);
    }

    [Fact]
    public void PInvokeCallInsideInvokedFunction_ReportsGS0514()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            func CallNative() nint {
                return NativeStrLen("Hello")
            }

            Console.WriteLine(CallNative())
            """;

        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.True(cell.HasError);
        Assert.Contains("NativeStrLen", diagnostic.Message);
    }

    [Fact]
    public void PInvokeDeclaredInEarlierCell_IsDiagnosedOnlyWhenUsed()
    {
        var engine = new SessionEngine { CaptureConsole = true };
        var declaration = engine.Evaluate(
            """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;
            """,
            "declaration.gs");

        var unrelated = engine.Evaluate("Console.WriteLine(33)", "unrelated.gs");
        var use = engine.Evaluate("let f = NativeStrLen", "use.gs");

        Assert.Empty(declaration.Diagnostics);
        Assert.Empty(unrelated.Diagnostics);
        Assert.Equal("33\n", unrelated.Output);
        var diagnostic = Assert.Single(use.Diagnostics);
        Assert.Equal("GS0514", diagnostic.Id);
        Assert.Equal("declaration.gs", diagnostic.Location.FileName);
    }

    /// <summary>
    /// ADR-0156 Phase 1: script-mode <c>gsi</c> executes emitted code, so the
    /// ADR-0152 native-call boundary (GS0514) no longer applies to file mode —
    /// the P/Invoke sample calls straight into libc and prints its golden
    /// output. GS0514 remains an interactive-REPL boundary (tests above).
    /// </summary>
    [Fact]
    public void BatchFileRunner_ExecutesPInvokeNatively()
    {
        if (OperatingSystem.IsWindows())
        {
            // The sample targets POSIX libc; the conformance gate skips it on
            // Windows for the same reason (WindowsSkippedSamples).
            return;
        }

        var pInvokePath = LocateSample("PInvoke.gs");
        var pInvoke = RunBatchFile(pInvokePath);
        Assert.Equal(0, pInvoke.ExitCode);
        Assert.Equal("13\n", pInvoke.StandardOutput.Replace("\r\n", "\n", StringComparison.Ordinal));
        Assert.Equal(string.Empty, pInvoke.StandardError);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) RunBatchFile(string path)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main([path]);
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string LocateSample(string fileName)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var path = Path.Combine(directory.FullName, "samples", fileName);
            if (File.Exists(path))
            {
                return path;
            }
        }

        throw new DirectoryNotFoundException($"Could not locate samples/{fileName}.");
    }
}
