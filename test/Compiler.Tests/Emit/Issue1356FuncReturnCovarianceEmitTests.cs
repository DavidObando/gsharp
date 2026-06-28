// <copyright file="Issue1356FuncReturnCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1356: a function-typed value whose return type is a bare type
/// parameter <c>T</c> implicitly converts to a function whose return type is the
/// nullable form <c>T?</c> of the same type parameter. Widening a non-null value
/// to its nullable form is always safe, so a <c>(T) -> T</c> flows into a
/// <c>(T) -> T?</c> slot. The reverse (<c>(T) -> T?</c> to <c>(T) -> T</c>) is a
/// null-dropping narrowing and stays rejected.
/// </summary>
public class Issue1356FuncReturnCovarianceEmitTests
{
    [Fact]
    public void Library_FuncReturnTypeParameterWidensToNullable_Compiles()
    {
        // The minimal repro from issue #1356: a `(T) -> T` lambda is stored in a
        // `(T) -> T?` field. Before the fix this errored with GS0155.
        var source = """
            package p

            class Box[T] {
                let f (T) -> T?
                init(g (T) -> T) {
                    this.f = g
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_ConcreteReferenceReturnWidensToNullable_StillCompiles()
    {
        // Control: concrete reference return widening must keep working.
        var source = """
            package p

            class Box {
                let f (int32) -> string?
                init(g (int32) -> string) {
                    this.f = g
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_ReferenceCovariantReturn_StillCompiles()
    {
        // Control: reference covariance on the return type must keep working.
        var source = """
            package p

            class Box {
                let f () -> object
                init(g () -> string) {
                    this.f = g
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void Library_NullableReturnDoesNotNarrowToNonNullable_IsRejected()
    {
        // Negative control: the unsafe reverse direction (`(T) -> T?` into a
        // `(T) -> T` slot) drops the nullable annotation and must be rejected.
        var source = """
            package p

            class Box[T] {
                let f (T) -> T
                init(g (T) -> T?) {
                    this.f = g
                }
            }
            """;

        var (exit, stdout, stderr) = TryCompileLibrary(source);
        Assert.True(exit != 0, $"expected compile failure but succeeded.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Contains("GS0155", stdout + stderr);
    }

    [Fact]
    public void EndToEnd_BoxOfString_StoresAndInvokesNullableReturningField()
    {
        // A `Box[string]` built from a `(string) -> string` lambda stores the
        // lambda in its `(string) -> string?` field and invoking it returns a
        // `string?` carrying the computed value at runtime. A reference-type
        // reification exercises the conversion soundly: `string?` shares the CLR
        // representation of `string`, so the widened function is the same
        // delegate and the runtime value flows through unchanged.
        var source = """
            package p

            class Box[T] {
                let f (T) -> T?
                init(g (T) -> T) {
                    this.f = g
                }

                func apply(x T) T? {
                    return this.f(x)
                }
            }

            func Main() {
                let b = Box[string](func (x string) string { return x + "!" })
                System.Console.WriteLine(b.apply("hi"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi!\n", output);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1356_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static (int Exit, string Stdout, string Stderr) TryCompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1356_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
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

            return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1356_exe_").FullName;
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

            RunCompiler(args);
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

    private static void RunCompiler(string[] args)
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

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
