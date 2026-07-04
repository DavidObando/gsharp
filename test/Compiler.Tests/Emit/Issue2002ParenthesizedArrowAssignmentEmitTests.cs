// <copyright file="Issue2002ParenthesizedArrowAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2002 / ADR-0122 §4: end-to-end emit + execution tests for
/// assignment through an EXPLICITLY PARENTHESIZED pointer-arrow receiver —
/// <c>(expr)-&gt;Member = value</c>. Before the fix, the parser's <c>(...) -&gt;</c>
/// lambda-vs-pointer-arrow disambiguator (<c>LooksLikeLambdaStart</c>)
/// mis-parsed this shape as a lambda expression (silently, for a bare
/// identifier receiver) or reported a spurious GS0005 (for any other
/// receiver, e.g. a dereference), depending on the exact interior shape.
/// Covers the motivating double-indirection write <c>(*pp)-&gt;X = value</c>
/// (where <c>pp</c> is a pointer-to-a-pointer, <c>**Point</c>) alongside the
/// simpler single-parenthesized-receiver write, confirming both that parsing
/// no longer fails and that the write actually lands at runtime.
/// </summary>
public class Issue2002ParenthesizedArrowAssignmentEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    private const string PointStruct = """
        package Probe
        import System

        struct Point {
            var x int32
        }

        """;

    [Fact]
    public void ParenthesizedArrowReceiver_Assignment_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1}}
                var p = &arr[0]
                (p)->x = 42
                Console.WriteLine(arr[0].x)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void DoubleIndirection_ParenthesizedDerefArrow_Assignment_CompilesAndRuns()
    {
        var source = PointStruct + """
            unsafe func run() {
                var arr = []Point{Point{x: 1}}
                var p *Point = &arr[0]
                var pp **Point = &p
                Console.WriteLine((*pp)->x)
                (*pp)->x = 77
                Console.WriteLine(arr[0].x)
                Console.WriteLine((*pp)->x)
            }

            run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n77\n77\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2002_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            // Unsafe pointer code is unverifiable by design; tolerate the
            // inherent-unsafety error codes while still gating on other
            // verification regressions.
            IlVerifier.Verify(outPath, null, UnsafeIlVerifyIgnored);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
