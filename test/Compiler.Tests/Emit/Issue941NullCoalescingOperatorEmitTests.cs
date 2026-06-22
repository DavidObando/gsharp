// <copyright file="Issue941NullCoalescingOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #941: the binary null-coalescing operator <c>a ?? b</c> (replacing the
/// removed <c>?:</c> spelling). Evaluates <c>a</c>; if non-nil yields <c>a</c>,
/// otherwise evaluates and yields <c>b</c>. The right operand is evaluated
/// lazily, <c>??</c> is right-associative and binds lower than <c>||</c>, and the
/// removed <c>?:</c> spelling is now a parse error (GS0005).
///
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then executes
/// it under <c>dotnet exec</c> and asserts on captured stdout.
/// </summary>
public class Issue941NullCoalescingOperatorEmitTests
{
    [Fact]
    public void ReferenceTypeFallback_LeftNil_ReturnsRight()
    {
        var source = """
            package P

            import System

            func OrDefault(value string?, fallback string) string {
                return value ?? fallback
            }

            Console.WriteLine(OrDefault(nil, "fallback"))
            Console.WriteLine(OrDefault("present", "fallback"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("fallback\npresent\n", output);
    }

    [Fact]
    public void NullableValueTypeFallback_LeftNil_ReturnsRightUnderlying()
    {
        var source = """
            package P

            import System

            let absent int32? = nil
            let present int32? = 7
            Console.WriteLine((absent ?? -1).ToString())
            Console.WriteLine((present ?? -1).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-1\n7\n", output);
    }

    [Fact]
    public void Chained_RightAssociative_FallsThroughToFirstNonNil()
    {
        var source = """
            package P

            import System

            let a string? = nil
            let b string? = nil
            let c string? = "third"
            Console.WriteLine(a ?? b ?? c ?? "last")

            let x string? = nil
            let y string? = "second"
            Console.WriteLine(x ?? y ?? "last")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("third\nsecond\n", output);
    }

    [Fact]
    public void ShortCircuit_RightSideNotEvaluated_WhenLeftNonNil()
    {
        // The right operand has an observable side effect (prints SIDE). When
        // the left operand is non-nil, the right operand must NOT be evaluated,
        // so SIDE must not appear in stdout.
        var source = """
            package P

            import System

            func Side() string {
                Console.WriteLine("SIDE")
                return "from-side"
            }

            let present string? = "present"
            Console.WriteLine(present ?? Side())

            let absent string? = nil
            Console.WriteLine(absent ?? Side())
            """;

        var output = CompileAndRun(source);

        // present branch: prints "present" and never calls Side().
        // absent branch: calls Side() (prints "SIDE") then yields "from-side".
        Assert.Equal("present\nSIDE\nfrom-side\n", output);
    }

    [Fact]
    public void CompoundAssignment_StillWorks()
    {
        // Regression guard: `??=` (ADR-0072) continues to work unchanged
        // alongside the new `??` read operator.
        var source = """
            package P

            import System

            var x string? = nil
            x ??= "defaulted"
            Console.WriteLine(x ?? "n/a")

            var y string? = "kept"
            y ??= "ignored"
            Console.WriteLine(y ?? "n/a")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("defaulted\nkept\n", output);
    }

    [Fact]
    public void RemovedElvisSpelling_IsParseError()
    {
        // Issue #941: the former `?:` null-coalescing spelling was removed.
        // `a ?: b` no longer parses — the lexer yields `?` then `:`, and the
        // parser reports GS0005.
        var source = """
            package P

            import System

            let x string? = nil
            Console.WriteLine(x ?: "fallback")
            """;

        var (exitCode, _, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0005", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Diagnostics) CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue941_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (compileExit, compileOut.ToString(), compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue941_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
