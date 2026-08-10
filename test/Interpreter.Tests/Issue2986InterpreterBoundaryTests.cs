// <copyright file="Issue2986InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2986: the interpreter native-call boundary (GS0514, ADR-0152) is
/// gone — every driver executes emitted code, so P/Invoke runs natively
/// everywhere. The interactive GS0514 pins that lived here drove the legacy
/// tree-walking <c>SessionEngine</c> explicitly and retired with the
/// evaluator in ADR-0156 Phase 3c (#3176); what remains is the emitted
/// script-mode proof that P/Invoke calls straight into libc.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2986InterpreterBoundaryTests
{
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
        Assert.Equal($"13{Environment.NewLine}", pInvoke.StandardOutput.ReplaceLineEndings(Environment.NewLine));
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
