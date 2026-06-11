// <copyright file="Issue708IfLetGuardLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #708 / ADR-0071 — emit coverage for <c>if let</c> /
/// <c>guard let</c> nullable-binding statements. Each test compiles via
/// in-process <c>gsc</c>, IL-verifies the emitted PE (so the synthesized
/// nil-checks and inner blocks are well-formed), and runs the assembly
/// under <c>dotnet exec</c>, asserting captured stdout.
/// </summary>
public class Issue708IfLetGuardLetEmitTests
{
    [Fact]
    public void IfLet_PrintsBindingWhenNonNil_NoElse()
    {
        var source = """
            package Test
            import System

            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine("got:" + v)
                }
            }

            Demo("hello")
            Demo(nil)
            """;

        Assert.Equal("got:hello\n", CompileAndRun(source));
    }

    [Fact]
    public void IfLetElse_RunsThenBranchWhenNonNil_AndElseWhenNil()
    {
        var source = """
            package Test
            import System

            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine("got:" + v)
                } else {
                    Console.WriteLine("nil")
                }
            }

            Demo("a")
            Demo(nil)
            """;

        Assert.Equal("got:a\nnil\n", CompileAndRun(source));
    }

    [Fact]
    public void IfLet_MultipleBindings_AllOrNothing()
    {
        var source = """
            package Test
            import System

            func Demo(a string?, b string?) {
                if let x = a, let y = b {
                    Console.WriteLine("both:" + x + "/" + y)
                } else {
                    Console.WriteLine("missing")
                }
            }

            Demo("a", "b")
            Demo("a", nil)
            Demo(nil, "b")
            Demo(nil, nil)
            """;

        Assert.Equal("both:a/b\nmissing\nmissing\nmissing\n", CompileAndRun(source));
    }

    [Fact]
    public void GuardLet_ContinuesWhenNonNil_AndExitsViaElseWhenNil()
    {
        var source = """
            package Test
            import System

            func Demo(s string?) {
                guard let v = s else {
                    Console.WriteLine("nil-exit")
                    return
                }
                Console.WriteLine("ok:" + v)
            }

            Demo("hi")
            Demo(nil)
            """;

        Assert.Equal("ok:hi\nnil-exit\n", CompileAndRun(source));
    }

    [Fact]
    public void GuardLet_MultipleBindings_FirstNilExits()
    {
        var source = """
            package Test
            import System

            func Demo(a string?, b string?) {
                guard let x = a, let y = b else {
                    Console.WriteLine("exit")
                    return
                }
                Console.WriteLine("both:" + x + "/" + y)
            }

            Demo("a", "b")
            Demo("a", nil)
            Demo(nil, "b")
            """;

        Assert.Equal("both:a/b\nexit\nexit\n", CompileAndRun(source));
    }

    [Fact]
    public void IfLet_NestedNarrowing_AllowsMemberAccess()
    {
        // Inside the then-branch, the narrowed `v` is usable as a plain
        // `string` (no further nil-guard needed for `.Length`).
        var source = """
            package Test
            import System

            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine(v.Length)
                }
            }

            Demo("abc")
            Demo("xyzz")
            Demo(nil)
            """;

        Assert.Equal("3\n4\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue708_").FullName;
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
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
