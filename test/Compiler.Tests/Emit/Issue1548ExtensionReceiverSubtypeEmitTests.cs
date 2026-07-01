// <copyright file="Issue1548ExtensionReceiverSubtypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1548 — a receiver-clause (extension) function <c>func (r R) Name(…)</c>
/// only bound when the call-site receiver type was EXACTLY <c>R</c> (identity /
/// same-CLR-type). It must also bind when the call-site receiver type <c>S</c>
/// is implicitly convertible to <c>R</c> (identity, implicit reference, or
/// boxing conversion), matching C#/Kotlin extension-method receiver semantics.
/// cs2gs translates C# extension methods into receiver-clause funcs, so the
/// exact-only rule blocked most real Oahu translations (the minimal repro
/// <c>func (o object?) IsNull() bool</c> called on a <c>string</c> emitted
/// <c>GS0159: Cannot find function IsNull.</c>).
/// <para>
/// The fix broadens <c>BoundScope.ReceiverConvertible</c> gating on the extension
/// lookup paths: a CONCRETE declared receiver is applicable whenever
/// <c>Conversion.Classify(S, R)</c> is <c>Exists &amp;&amp; IsImplicit</c>. The
/// exact / same-CLR fast path is still tried first, and the open-receiver
/// generic-unification fallback (#773 / #775) is preserved. Specificity is kept:
/// the plural path collects every applicable candidate and lets overload
/// resolution (which scores the receiver as parameter 0) select the most
/// specific one; the singular path ranks convertible candidates so the
/// most-derived receiver wins deterministically.
/// </para>
/// <para>
/// VALUE-TYPE BOXING IS IN SCOPE: an <c>(o object)</c> extension binds on an
/// <c>int32</c> receiver via a boxing conversion, matching C# (which permits an
/// extension on <c>object</c> to be invoked on a value type).
/// </para>
/// <para>
/// Interface and base-class generalization are demonstrated with BCL types
/// (<c>System.IDisposable</c>, <c>System.IO.Stream</c>): a same-package USER
/// interface/aggregate receiver-clause is intentionally rejected by G# (GS0103 /
/// GS0314, ADR-0079/0085 — those belong in the type as a DIM / member), so only
/// non-owned (imported/BCL) receiver types exercise the extension-lookup path
/// that this fix changes. Each test uses a UNIQUE package name and unique user
/// type names because the in-process <c>FunctionTypeSymbol</c> cache is
/// name-keyed for user types.
/// </para>
/// </summary>
public class Issue1548ExtensionReceiverSubtypeEmitTests
{
    /// <summary>
    /// The minimal repro: an <c>object?</c> extension bound on a <c>string</c>
    /// receiver via an implicit reference conversion.
    /// </summary>
    [Fact]
    public void ExtensionOnObject_CalledOnString_Runs()
    {
        const string source = """
            package i1548objstr
            import System

            func (o object?) IsNull1548() bool -> o == nil

            func Use(p string) bool -> p.IsNull1548()

            func Main() { Console.WriteLine(Use("hi")) }
            """;

        Assert.Equal("False\n", CompileAndRun(source));
    }

    /// <summary>
    /// An <c>object?</c> extension bound on a BCL reference receiver
    /// (<c>System.Text.StringBuilder</c>) via an implicit reference conversion.
    /// </summary>
    [Fact]
    public void ExtensionOnObject_CalledOnBclReference_Runs()
    {
        const string source = """
            package i1548objbcl
            import System
            import System.Text

            func (o object?) IsNull1548() bool -> o == nil

            func Main() {
                let b StringBuilder = StringBuilder()
                Console.WriteLine(b.IsNull1548())
            }
            """;

        Assert.Equal("False\n", CompileAndRun(source));
    }

    /// <summary>
    /// GENERALIZATION — an extension whose declared receiver is an INTERFACE
    /// (<c>System.IDisposable</c>) binds on a user class that implements it,
    /// through an implicit class-to-implemented-interface reference conversion.
    /// </summary>
    [Fact]
    public void ExtensionOnInterface_CalledOnImplementingClass_Runs()
    {
        const string source = """
            package i1548iface
            import System

            class Res1548 : IDisposable { func Dispose() { } }

            func (d IDisposable) Tag1548() int32 -> 42

            func Use() int32 {
                let r Res1548 = Res1548()
                return r.Tag1548()
            }

            func Main() { Console.WriteLine(Use()) }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    /// <summary>
    /// GENERALIZATION — an extension whose declared receiver is a base class
    /// (<c>System.IO.Stream</c>) binds on a derived class
    /// (<c>System.IO.MemoryStream</c>) through an implicit derived-to-base
    /// reference conversion.
    /// </summary>
    [Fact]
    public void ExtensionOnBaseClass_CalledOnDerivedClass_Runs()
    {
        const string source = """
            package i1548base
            import System
            import System.IO

            func (s Stream) Tag1548() int32 -> 11

            func Use() int32 {
                let m MemoryStream = MemoryStream()
                return m.Tag1548()
            }

            func Main() { Console.WriteLine(Use()) }
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    /// <summary>
    /// VALUE-TYPE BOXING — an <c>object</c> extension binds on an <c>int32</c>
    /// receiver via a boxing conversion (in scope, as in C#).
    /// </summary>
    [Fact]
    public void ExtensionOnObject_CalledOnValueType_BoxesAndRuns()
    {
        const string source = """
            package i1548box
            import System

            func (o object) Boxed1548() int32 -> 7

            func Use(n int32) int32 -> n.Boxed1548()

            func Main() { Console.WriteLine(Use(3)) }
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    /// <summary>
    /// SPECIFICITY — with both a <c>(s string)</c> and an <c>(o object)</c>
    /// overload visible, a call on a <c>string</c> receiver must select the more
    /// specific <c>string</c> receiver (result <c>1</c>), NOT report a spurious
    /// GS0160 ambiguity.
    /// </summary>
    [Fact]
    public void Specificity_StringBeatsObject_OnStringReceiver()
    {
        const string source = """
            package i1548specstr
            import System

            func (s string) F1548() int32 -> 1
            func (o object) F1548() int32 -> 2

            func Use(s string) int32 -> s.F1548()

            func Main() { Console.WriteLine(Use("x")) }
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    /// <summary>
    /// SPECIFICITY — with both a <c>(s string)</c> and an <c>(o object)</c>
    /// overload visible, a call on a NON-string reference receiver
    /// (<c>System.Text.StringBuilder</c>) must select the <c>object</c> receiver
    /// (result <c>2</c>), the only applicable candidate.
    /// </summary>
    [Fact]
    public void Specificity_ObjectSelected_OnNonStringReference()
    {
        const string source = """
            package i1548specobj
            import System
            import System.Text

            func (s string) F1548() int32 -> 1
            func (o object) F1548() int32 -> 2

            func Use() int32 {
                let b StringBuilder = StringBuilder()
                return b.F1548()
            }

            func Main() { Console.WriteLine(Use()) }
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    /// <summary>
    /// NEGATIVE — a genuinely non-convertible receiver (<c>int32</c> for a
    /// <c>string</c>-only extension) still reports GS0159; broadening to implicit
    /// conversions must not make unrelated receivers bind.
    /// </summary>
    [Fact]
    public void NonConvertibleReceiver_StillReportsGs0159()
    {
        const string source = """
            package i1548neg
            import System

            func (s string) OnlyString1548() int32 -> 1

            func Use(x int32) int32 -> x.OnlyString1548()

            func Main() { Console.WriteLine("x") }
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0159", output);
    }

    /// <summary>
    /// REGRESSION — the generic-receiver unification fallback (#773 / #775) for
    /// an OPEN declared receiver carrying the function's own type parameters
    /// still binds after the subtype broadening.
    /// </summary>
    [Fact]
    public void GenericReceiverFallback_StillBinds()
    {
        const string source = """
            package i1548generic
            import System

            func (self sequence[T]) HeadOr1548[T](fb T) T {
                return fb
            }

            var arr = []int32{1, 2, 3}
            Console.WriteLine(arr.HeadOr1548(7))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1548_exe_").FullName;
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

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1548_neg_").FullName;
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

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
