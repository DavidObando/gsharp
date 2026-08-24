// <copyright file="Issue2840NullableFunctionToDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2840 — a structural function type failed to convert to a nominal
/// delegate whenever the SOURCE was nullable.
/// <para>
/// The issue reported the trigger as "type-parameter substitution from the
/// enclosing generic class", but the minimal repro needs neither generics nor
/// a second assembly: <c>((Src) -&gt; void)?</c> would not convert to
/// <c>System.Action[Src]?</c> for a source-declared class <c>Src</c>, while the
/// bare non-nullable conversion was fine.
/// </para>
/// <para>
/// Root cause: <c>Conversion.IsReferenceLikeTarget</c> did not recognise
/// <c>FunctionTypeSymbol</c>. A structural function type only has a
/// <c>ClrType</c> when EVERY type in its signature is CLR-backed, so a single
/// source-declared class anywhere in its parameter or return list leaves it
/// null and the trailing <c>ClrType</c> fallback reported it as
/// non-reference-like. That gated off the <c>T? -&gt; U?</c> reference arm.
/// Emit needed the matching wrapper strip, plus the symbolic-<c>Invoke</c>
/// fallback its CLR-delegate sibling already had.
/// </para>
/// Each fact uses a UNIQUE package name because the in-process type caches are
/// name-keyed.
/// </summary>
public class Issue2840NullableFunctionToDelegateEmitTests
{
    [Fact]
    public void EndToEnd_NullableStructuralFunctionToNullableImportedDelegate_SourceClassInSignature_Runs()
    {
        // The true minimal repro: no generics, no named delegate, no second
        // assembly. `Src` being declared in this compilation is what nulls the
        // function type's ClrType.
        const string source = """
            package i2840minimal
            import System

            class Src {
                prop N int32 -> 5
            }

            func Main() {
                var f ((Src) -> void)? = nil
                f = (s Src) -> System.Console.WriteLine(s.N)
                var d System.Action[Src]? = f
                if d != nil {
                    d(Src())
                }
            }
            """;

        Assert.Equal($"5{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_NullableStructuralFunctionToNullableNamedDelegate_SourceClassInSignature_Runs()
    {
        const string source = """
            package i2840named
            import System

            class Src {
                prop N int32 -> 6
            }

            delegate PD(s Src) void;

            func Main() {
                var f ((Src) -> void)? = nil
                f = (s Src) -> System.Console.WriteLine(s.N)
                var d PD? = f
                if d != nil {
                    d(Src())
                }
            }
            """;

        Assert.Equal($"6{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_NullableStructuralFunctionToNullableNamedDelegate_BclOnlySignature_Runs()
    {
        // Same shape but with a fully CLR-backed signature, so the source
        // function type DOES have a ClrType. This one is gated purely by the
        // named delegate target lacking one.
        const string source = """
            package i2840namedbcl
            import System

            delegate PD(x int32) void;

            func Main() {
                var f ((int32) -> void)? = nil
                f = (x int32) -> System.Console.WriteLine(x * 3)
                var d PD? = f
                if d != nil {
                    d(9)
                }
            }
            """;

        Assert.Equal($"27{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_FunctionVariableToNamedDelegate_SourceClassInSignature_Runs()
    {
        // The adjacent emit gap this fix also had to close: a function VALUE
        // (not a literal or method group) flowing into a named delegate needs
        // the symbolic `Invoke` MemberRef, because the source function type has
        // no ClrType. Non-nullable on both sides — reachable independently of
        // the nullable arm, and reachable through it once the binder accepts
        // the nullable form.
        const string source = """
            package i2840fnvar
            import System

            class Src {
                prop N int32 -> 8
            }

            delegate PD(s Src) void;

            func Main() {
                let f ((Src) -> void) = (s Src) -> System.Console.WriteLine(s.N)
                var d PD = f
                d(Src())
            }
            """;

        Assert.Equal($"8{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SameCompilation_EnclosingGenericClass_NullableDelegateParameter_Runs()
    {
        // The issue's "same-compilation" FAIL row.
        const string source = """
            package i2840samecomp
            import System

            interface ICanc {
                prop IsCancelled bool { get }
            }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Jobb[T ICanc] {
                func Do(ctx T, convertAction Conv[T]?) {
                    if convertAction != nil {
                        convertAction(7, ctx, (s string) -> System.Console.WriteLine(s))
                    }
                }
            }

            class Cancel : ICanc {
                prop IsCancelled bool -> false
            }

            func Main() {
                let job = Jobb[Cancel]()
                var convertAction ((int32, Cancel, (string) -> void) -> void)? = nil
                convertAction = (book int32, ctx Cancel, onState (string) -> void) -> {
                    onState("same" + System.Convert.ToString(book))
                }
                job.Do(Cancel(), convertAction)
                job.Do(Cancel(), nil)
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal($"same7{Environment.NewLine}done{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_CrossAssembly_EnclosingGenericClass_NullableDelegateParameter_Runs()
    {
        // The issue's headline cross-assembly FAIL row and the originating Oahu
        // shape (`MainWindow.axaml.gs:345`).
        const string library = """
            package i2840lib
            import System

            interface ICanc {
                prop IsCancelled bool { get }
            }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Jobb[T ICanc] {
                func Do(ctx T, convertAction Conv[T]?) {
                    if convertAction != nil {
                        convertAction(7, ctx, (s string) -> System.Console.WriteLine(s))
                    }
                }
            }
            """;

        const string consumer = """
            package i2840use
            import System
            import i2840lib

            class Cancel : ICanc {
                prop IsCancelled bool -> false
            }

            func Main() {
                let job = Jobb[Cancel]()
                var convertAction ((int32, Cancel, (string) -> void) -> void)? = nil
                convertAction = (book int32, ctx Cancel, onState (string) -> void) -> {
                    onState("cross" + System.Convert.ToString(book))
                }
                job.Do(Cancel(), convertAction)
                job.Do(Cancel(), nil)
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal($"cross7{Environment.NewLine}done{Environment.NewLine}", CompileAndRun(consumer, library, "i2840lib"));
    }

    [Fact]
    public void EndToEnd_GenericMethodOnNonGenericClass_NullableDelegateParameter_Runs()
    {
        // Control: the issue's PASS row for a generic METHOD. A fix for the
        // enclosing-class form must not regress it.
        const string source = """
            package i2840genmethod
            import System

            interface ICanc {
                prop IsCancelled bool { get }
            }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Jobb {
                func Do[T ICanc](ctx T, convertAction Conv[T]?) {
                    if convertAction != nil {
                        convertAction(3, ctx, (s string) -> System.Console.WriteLine(s))
                    }
                }
            }

            class Cancel : ICanc {
                prop IsCancelled bool -> false
            }

            func Main() {
                let job = Jobb()
                var convertAction ((int32, Cancel, (string) -> void) -> void)? = nil
                convertAction = (book int32, ctx Cancel, onState (string) -> void) -> {
                    onState("gm" + System.Convert.ToString(book))
                }
                job.Do(Cancel(), convertAction)
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal($"gm3{Environment.NewLine}done{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_StaticGenericFunction_NullableDelegateParameter_Runs()
    {
        const string source = """
            package i2840staticgeneric
            import System

            interface ICanc {
                prop IsCancelled bool { get }
            }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Cancel : ICanc {
                prop IsCancelled bool -> false
            }

            func Do[T ICanc](ctx T, convertAction Conv[T]?) {
                if convertAction != nil {
                    convertAction(4, ctx, (s string) -> System.Console.WriteLine(s))
                }
            }

            func Main() {
                var ca ((int32, Cancel, (string) -> void) -> void)? = nil
                ca = (book int32, ctx Cancel, onState (string) -> void) -> {
                    onState("sg")
                }
                Do(Cancel(), ca)
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal($"sg{Environment.NewLine}done{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_NonNullableStructuralFunctionToDelegate_StillRuns()
    {
        // Control: the non-nullable direction that always worked.
        const string source = """
            package i2840control
            import System

            class Src {
                prop N int32 -> 2
            }

            func Main() {
                let f ((Src) -> void) = (s Src) -> System.Console.WriteLine(s.N)
                var d System.Action[Src] = f
                d(Src())
                var n System.Action[Src]? = f
                if n != nil {
                    n(Src())
                }
            }
            """;

        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2840_exe_").FullName;
        try
        {
            string libDll = null;
            if (library != null)
            {
                // ilverify resolves `-r` references by FILE NAME, so the
                // library must be written out under its assembly identity.
                var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
                File.WriteAllText(libSrc, library);
                Compile(new[]
                {
                    "/out:" + libDll,
                    "/target:library",
                    "/targetframework:net10.0",
                    libSrc,
                });
                IlVerifier.Verify(libDll);
            }

            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            if (libDll != null)
            {
                args.Add("/r:" + libDll);
            }

            args.Add(srcPath);
            Compile(args.ToArray());
            IlVerifier.Verify(dllPath, libDll != null ? new[] { libDll } : null);

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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void Compile(string[] args)
    {
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
    }
}
