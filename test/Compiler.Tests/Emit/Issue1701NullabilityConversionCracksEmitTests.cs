// <copyright file="Issue1701NullabilityConversionCracksEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end regression coverage for issue #1701 crack 2
/// (<c>Conversion.Classify</c>'s nullable-open-type-parameter arm). The fix
/// blocks the implicit <c>T? -> object</c>/interface box when <c>T</c> is
/// provably a reference type: bare <c>class</c> (<c>HasReferenceTypeConstraint</c>,
/// e.g. <c>[T class]</c>) or a class-base constraint (<c>ClassConstraint</c>,
/// e.g. <c>[T Box]</c>) — the only shapes where <c>T?</c> is a genuine
/// nullable reference. An earlier revision of the fix instead gated on
/// <c>HasValueTypeConstraint</c>, which blocked every non-struct-constrained
/// shape (unconstrained, interface-constrained) and regressed issue #1455.
/// These tests assert the class-constrained crack stays closed while the
/// #1455 unconstrained/interface-constrained boxing keeps compiling and
/// running.
/// </summary>
public class Issue1701NullabilityConversionCracksEmitTests
{
    [Fact]
    public void ClassConstrainedNullableTypeParam_ToObject_IsBlocked()
    {
        // The actual #1701 crack: T is provably reference-nullable, so the
        // implicit box must be rejected rather than erasing a possibly-null
        // value into a non-null `object` slot.
        var source = """
            package Probe1701Block
            func Sink[T class](x T?) object -> x
            """;

        var (exitCode, stderr) = TryCompile(source);
        Assert.NotEqual(0, exitCode);
        Assert.True(
            stderr.Contains("GS0154") || stderr.Contains("GS0155") || stderr.Contains("Cannot convert"),
            $"expected a null-safety diagnostic, got:\n{stderr}");
    }

    [Fact]
    public void ClassBaseConstrainedNullableTypeParam_ToObject_ReportsNullSafetyDiagnostic()
    {
        // Same crack, different constraint shape: a class-BASE constraint
        // (`[T Box]`) only populates `ClassConstraint`, never
        // `HasReferenceTypeConstraint` (that flag is set solely by the bare
        // `class` keyword). But `Box` being an `open class` still proves `T`
        // is a reference type, so `T?` is a genuine nullable reference here
        // too — the implicit box must be rejected exactly like `[T class]`.
        var source = """
            package Probe1701ClassBaseBlock
            open class Box { }
            func Sink[T Box](x T?) object -> x
            """;

        var (exitCode, stderr) = TryCompile(source);
        Assert.NotEqual(0, exitCode);
        Assert.True(
            stderr.Contains("GS0154") || stderr.Contains("GS0155") || stderr.Contains("Cannot convert"),
            $"expected a null-safety diagnostic, got:\n{stderr}");
    }

    [Fact]
    public void InterfaceConstrainedNullableTypeParam_ToInterface_BoxesAndRuns()
    {
        // #1455 guard: interface-only constraint is not provably
        // reference-nullable (a struct can implement the interface), so this
        // must NOT be blocked.
        var source = """
            package Probe1701Iface
            import System

            open class Holder[T IComparable] {
                private var value T
                init(v T) { this.value = v }
                func GetMaybe() T? -> this.value
                func AsComparable() IComparable -> GetMaybe()
            }

            func Main() {
                let h = Holder[int32](3)
                Console.WriteLine(h.AsComparable()!!.CompareTo(3).ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void UnconstrainedNullableTypeParam_InstantiatedWithStruct_ArgumentToObject_BoxesAndRuns()
    {
        // #1455 guard: an unconstrained T's `!!T` box works for both struct
        // and reference instantiations. Argument-position case with a struct
        // instantiation must not be blocked.
        var source = """
            package Probe1701Unconstrained
            import System
            import System.Collections.Generic

            open class Holder[T] {
                private var value T
                init(v T) { this.value = v }
                func GetMaybe() T? { return this.value }
                func Stash() List[object] {
                    let lst = List[object]()
                    lst.Add(GetMaybe())
                    return lst
                }
            }

            func Main() {
                let h = Holder[int32](11)
                Console.WriteLine(h.Stash()[0]!!.ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    private static (int ExitCode, string Stderr) TryCompile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1701_compile_").FullName;
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

            return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1701_exe_").FullName;
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
