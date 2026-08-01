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

/// <summary>Issue #2986: explicit interpreter native-call boundary.</summary>
[Collection("ConsoleIo")]
public class Issue2986InterpreterBoundaryTests
{
    [Fact]
    public void PInvokeDeclaration_ReportsGS0514BeforeExecution()
    {
        var source = """
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
            func NativeStrLen(text string) nint;

            Console.WriteLine("unreachable")
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
        Assert.Contains("'gsc'", diagnostic.Message);
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
    }

    [Fact]
    public void BatchFileRunner_RendersPInvokeLocationAndUsesErrorExitCode()
    {
        var pInvokePath = LocateSample("PInvoke.gs");
        var pInvoke = RunBatchFile(pInvokePath);
        Assert.Equal(1, pInvoke.ExitCode);
        Assert.Contains($"{pInvokePath}(20,6,20,18): error GS0514:", pInvoke.StandardError);
        Assert.Contains("func NativeStrLen(text string) nint;", pInvoke.StandardError);
        Assert.Equal(string.Empty, pInvoke.StandardOutput);
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
