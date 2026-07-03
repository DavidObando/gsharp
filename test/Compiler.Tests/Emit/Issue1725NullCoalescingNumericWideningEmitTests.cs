// <copyright file="Issue1725NullCoalescingNumericWideningEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1725 — cs2gs's <c>TranslateNullCoalescing</c> unconditionally
/// coerced the right operand of <c>a ?? b</c> down to the left operand's
/// underlying numeric type whenever the two numeric kinds differed. That only
/// matches C# when the right operand implicitly converts to the left's
/// underlying type; when the right side is wider, C# types <c>a ?? b</c> as
/// the right operand's (wider) type and converts the LEFT's value instead —
/// the buggy translation truncated the right operand. These are end-to-end
/// runtime checks of the underlying gsc <c>??</c> semantics that the cs2gs
/// fix now relies on (rather than re-deriving them with its own lowering):
/// gsc's own <c>??</c> binder (issue #1239) already performs C#'s
/// best-common-type widening and auto-converts the left operand's non-null
/// value, so the translated G# for each of these C# snippets is the
/// untouched <c>a ?? b</c> (verified separately by the Cs2Gs.Tests
/// translation tests) and must therefore produce the widened, non-truncated
/// runtime value below.
/// </summary>
public class Issue1725NullCoalescingNumericWideningEmitTests
{
    [Fact]
    public void RightWiderThanLeft_Int64_DoesNotTruncate()
    {
        const string source = """
            package i1725rightwiderlong
            import System

            func N(nInt int32?, longDefault int64) int64 -> nInt ?? longDefault

            func Main() {
                System.Console.WriteLine(N(nil, 5000000000))
                System.Console.WriteLine(N(3, 5000000000))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5000000000\n3\n", output);
    }

    [Fact]
    public void RightWiderThanLeft_Double_KeepsFraction()
    {
        const string source = """
            package i1725rightwiderdouble
            import System

            func N(nInt int32?) double -> nInt ?? 2.5

            func Main() {
                System.Console.WriteLine(N(nil))
                System.Console.WriteLine(N(2))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2.5\n2\n", output);
    }

    [Fact]
    public void RightWiderThanLeft_NonConstantDouble_KeepsFraction()
    {
        const string source = """
            package i1725rightwiderdoublevar
            import System

            func N(nInt int32?, otherDouble double) double -> nInt ?? otherDouble

            func Main() {
                System.Console.WriteLine(N(nil, 2.5))
                System.Console.WriteLine(N(9, 2.5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2.5\n9\n", output);
    }

    [Fact]
    public void LeftWiderThanRight_CoercesConstantUp()
    {
        const string source = """
            package i1725leftwider
            import System

            func N(nLong int64?) int64 -> nLong ?? 7

            func Main() {
                System.Console.WriteLine(N(nil))
                System.Console.WriteLine(N(42))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n42\n", output);
    }

    [Fact]
    public void EqualNumericKinds_NoCoercionNeeded()
    {
        const string source = """
            package i1725equalkinds
            import System

            func N(x uint32?, fallback uint32) uint32 -> x ?? fallback

            func Main() {
                System.Console.WriteLine(N(nil, 11u))
                System.Console.WriteLine(N(3u, 11u))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n3\n", output);
    }

    // N1: reviewer-flagged combos where cs2gs emits `left ?? rightAtResultType`
    // with NO explicit left coercion, relying entirely on gsc's `??` binder to
    // widen the left operand's non-null value up to the result type. Each is
    // an end-to-end lock of that gsc contract for a combo not covered above.
    [Fact]
    public void LeftWiderFloatToDouble_WidensNonNullValue()
    {
        const string source = """
            package i1725leftfloatdouble
            import System

            func N(f float?, d double) double -> f ?? d

            func Main() {
                System.Console.WriteLine(N(nil, 2.5))
                System.Console.WriteLine(N(3.0f, 2.5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2.5\n3\n", output);
    }

    [Fact]
    public void LeftWiderUintToLong_WidensNonNullValue()
    {
        const string source = """
            package i1725leftuintlong
            import System

            func N(u uint32?, l int64) int64 -> u ?? l

            func Main() {
                System.Console.WriteLine(N(nil, 5000000000))
                System.Console.WriteLine(N(4000000000u, 5000000000))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5000000000\n4000000000\n", output);
    }

    [Fact]
    public void LeftWiderIntToDecimal_WidensNonNullValue()
    {
        const string source = """
            package i1725leftintdecimal
            import System

            func N(i int32?, d decimal) decimal -> i ?? d

            func Main() {
                System.Console.WriteLine(N(nil, 2.5m))
                System.Console.WriteLine(N(7, 2.5m))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2.5\n7\n", output);
    }

    // N3 / issue #914: a constant signed/unsigned mismatch (`uint? x ?? 0`) —
    // the literal `0`'s natural type `int32` differs from the `uint32` result
    // C# computes, so cs2gs coerces the right constant to the result type
    // (`x ?? uint32(0)`, per Issue1725NullCoalescingResultTypeTranslationTests
    // .ConstantNarrowerThanUnsignedResult_StillCoerced). Locks the runtime
    // value of that translated form, not just its text.
    [Fact]
    public void ConstantUnsignedMismatch_ProducesCorrectRuntimeValue()
    {
        const string source = """
            package i1725constuintzero
            import System

            func N(x uint32?) uint32 -> x ?? uint32(0)

            func Main() {
                System.Console.WriteLine(N(nil))
                System.Console.WriteLine(N(5u))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1725_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
