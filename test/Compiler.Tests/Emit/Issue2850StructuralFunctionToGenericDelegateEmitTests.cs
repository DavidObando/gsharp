// <copyright file="Issue2850StructuralFunctionToGenericDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2850 — direct calls to generic free functions skipped the conversion
/// from a structural function value to a substituted nominal delegate parameter.
/// </summary>
public class Issue2850StructuralFunctionToGenericDelegateEmitTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StructuralFunctionArgument_AllGenericDeclaringForms_VerifyAndRun(bool nullable)
    {
        var suffix = nullable ? "nullable" : "nonnullable";
        var parameterType = nullable ? "Conv[T]?" : "Conv[T]";
        var nilCalls = nullable
            ? """
                genericJob.Do(Cancel(), nil)
                methodJob.Do(Cancel(), nil)
                DoStatic(Cancel(), nil)
                """
            : string.Empty;

        var source = $$"""
            package i2850{{suffix}}
            import System

            interface ICanc { prop IsCancelled bool { get } }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Cancel : ICanc { prop IsCancelled bool -> false }

            class GenericJob[T ICanc] {
                func Do(ctx T, convertAction {{parameterType}}) {
                    if convertAction != nil {
                        convertAction(4, ctx, (s string) -> System.Console.WriteLine("generic-class:" + s))
                    }
                }
            }

            class MethodJob {
                func Do[T ICanc](ctx T, convertAction {{parameterType}}) {
                    if convertAction != nil {
                        convertAction(4, ctx, (s string) -> System.Console.WriteLine("generic-method:" + s))
                    }
                }
            }

            func DoStatic[T ICanc](ctx T, convertAction {{parameterType}}) {
                if convertAction != nil {
                    convertAction(4, ctx, (s string) -> System.Console.WriteLine("static-function:" + s))
                }
            }

            func Main() {
                let genericJob = GenericJob[Cancel]()
                let methodJob = MethodJob()
                let ca ((int32, Cancel, (string) -> void) -> void) =
                    (book int32, ctx Cancel, onState (string) -> void) -> {
                        onState("{{suffix}}")
                    }
                genericJob.Do(Cancel(), ca)
                methodJob.Do(Cancel(), ca)
                DoStatic(Cancel(), ca)
                {{nilCalls}}
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal(
            "generic-class:" + suffix + Environment.NewLine
            + "generic-method:" + suffix + Environment.NewLine
            + "static-function:" + suffix + Environment.NewLine
            + $"done{Environment.NewLine}",
            CompileAndRun(source));
    }

    [Fact]
    public void GenericFreeFunction_ForwardsOpenStructuralFunctionToOpenNamedDelegate_VerifiesAndRuns()
    {
        const string source = """
            package i2850forward
            import System

            interface ICanc { prop IsCancelled bool { get } }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Cancel : ICanc { prop IsCancelled bool -> false }

            func Inner[T ICanc](ctx T, convertAction Conv[T]?) {
                if convertAction != nil {
                    convertAction(4, ctx, (s string) -> System.Console.WriteLine("inner:" + s))
                }
            }

            func Outer[T ICanc](ctx T, f ((int32, T, (string) -> void) -> void)) {
                Inner(ctx, f)
            }

            func Main() {
                let f ((int32, Cancel, (string) -> void) -> void) =
                    (book int32, ctx Cancel, onState (string) -> void) -> {
                        onState("fwd")
                    }
                Outer(Cancel(), f)
                System.Console.WriteLine("done")
            }
            """;

        Assert.Equal($"inner:fwd{Environment.NewLine}done{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NullableStructuralFunction_ToNonNullableGenericNamedDelegate_ReportsGS0155()
    {
        const string source = """
            package i2850nullabletononnullable
            import System

            interface ICanc { prop IsCancelled bool { get } }

            delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

            class Cancel : ICanc { prop IsCancelled bool -> false }

            func Do[T ICanc](ctx T, convertAction Conv[T]) {
            }

            func Main() {
                var ca ((int32, Cancel, (string) -> void) -> void)? = nil
                Do(Cancel(), ca)
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2850_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            Compile(new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
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

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2850_error_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + dllPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            var diagnostics = stdoutWriter.ToString() + stderrWriter.ToString();
            Assert.True(
                compileExit != 0,
                $"expected gsc to reject nullable structural function to non-nullable delegate:\n{diagnostics}");
            return diagnostics;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
