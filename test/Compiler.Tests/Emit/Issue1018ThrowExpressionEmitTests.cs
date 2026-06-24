// <copyright file="Issue1018ThrowExpressionEmitTests.cs" company="GSharp">
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
/// Issue #1018: <c>throw</c> usable as an EXPRESSION (a throw-expression),
/// mirroring C# (<c>x ?? throw e</c>, <c>cond ? a : throw e</c>, arrow bodies,
/// returned operands, arguments). The throw-expression has the bottom
/// (<c>never</c>) type, so the surrounding <c>??</c> / conditional takes the
/// sibling operand's type. Each test compiles via <c>gsc</c>, IL-verifies the
/// produced PE, then executes it under <c>dotnet exec</c> and asserts on the
/// captured stdout / exit code. The existing <c>throw</c> STATEMENT must keep
/// working unchanged.
/// </summary>
public class Issue1018ThrowExpressionEmitTests
{
    [Fact]
    public void NullCoalesceThrow_LeftNonNull_ReturnsLeft()
    {
        var source = """
            package P

            import System

            func firstNonNull(s string?) string {
                return s ?? throw Exception("was null")
            }

            Console.WriteLine(firstNonNull("hello"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void NullCoalesceThrow_LeftNull_Throws()
    {
        var source = """
            package P

            import System

            func firstNonNull(s string?) string {
                return s ?? throw Exception("boom-null")
            }

            var got = "none"
            try {
                Console.WriteLine(firstNonNull(nil))
            } catch (e Exception) {
                got = e.Message
            }

            Console.WriteLine(got)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("boom-null\n", output);
    }

    [Fact]
    public void NullCoalesceThrow_LeftNull_UncaughtExitsNonZero()
    {
        var source = """
            package P

            import System

            func firstNonNull(s string?) string {
                return s ?? throw Exception("uncaught")
            }

            Console.WriteLine(firstNonNull(nil))
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("uncaught", stderr);
    }

    [Fact]
    public void TernaryThrow_TrueBranchTaken_ReturnsValue()
    {
        var source = """
            package P

            import System

            func pick(cond bool, a int32) int32 {
                return cond ? a : throw Exception("nope")
            }

            Console.WriteLine(pick(true, 42).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void TernaryThrow_FalseBranchThrows()
    {
        var source = """
            package P

            import System

            func pick(cond bool, a int32) int32 {
                return cond ? a : throw Exception("ternary-boom")
            }

            var got = "none"
            try {
                Console.WriteLine(pick(false, 42).ToString())
            } catch (e Exception) {
                got = e.Message
            }

            Console.WriteLine(got)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ternary-boom\n", output);
    }

    [Fact]
    public void TernaryThrow_TrueBranchThrows()
    {
        var source = """
            package P

            import System

            func pick(cond bool, a string) string {
                return cond ? throw Exception("true-boom") : a
            }

            var got = "none"
            try {
                Console.WriteLine(pick(true, "x"))
            } catch (e Exception) {
                got = e.Message
            }

            Console.WriteLine(got)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("true-boom\n", output);
    }

    [Fact]
    public void ThrowExpression_InLambdaArrowBody()
    {
        var source = """
            package P

            import System

            func need(s string?) string {
                let f = (v string?) -> v ?? throw Exception("lambda null")
                return f(s)
            }

            Console.WriteLine(need("ok"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void ThrowExpression_InArgumentPosition()
    {
        var source = """
            package P

            import System

            func emit(s string?) {
                Console.WriteLine(string.Concat("got:", s ?? throw Exception("arg null")))
            }

            emit("argval")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("got:argval\n", output);
    }

    [Fact]
    public void ThrowStatement_StillWorks()
    {
        // Regression: a bare `throw e` at statement start must still behave as
        // the throw STATEMENT (intercepted by the statement parser), unchanged
        // by the new throw-expression support.
        var source = """
            package P

            import System

            func boom() {
                throw Exception("stmt-boom")
            }

            var got = "none"
            try {
                boom()
            } catch (e Exception) {
                got = e.Message
            }

            Console.WriteLine(got)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("stmt-boom\n", output);
    }

    [Fact]
    public void ThrowExpression_NonException_IsRejected()
    {
        // Negative: the thrown operand must be a System.Exception (or derived),
        // consistent with the throw-statement form.
        var source = """
            package P

            func bad(s string?) string {
                return s ?? throw 42
            }
            """;

        var (exitCode, _, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("System.Exception", diagnostics);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1018_err_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1018_").FullName;
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
