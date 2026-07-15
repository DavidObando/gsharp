// <copyright file="Issue2354ReturnNilAndSelfReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2345 follow-up (deferred finding #2): end-to-end compile → IL
/// verify → run coverage for the `return nil` / `return this` generalization
/// (binder-level coverage lives in
/// <c>Issue2354ReturnNilAndSelfReturnTests</c> in Core.Tests). These tests
/// prove the fix is not merely binder-level — the emitter's parallel
/// `IsReferenceCompatible` self-instantiation-identity check (mirroring
/// <c>Conversion.AreSameConstructedStructIdentity</c>) and its
/// <c>Conversion.IsNilAssignableWithoutNullableWrapper</c>-driven `nil`
/// no-op path both produce correct, verifiable IL that runs and returns the
/// expected values.
/// </summary>
public class Issue2354ReturnNilAndSelfReturnEmitTests
{
    [Fact]
    public void GenericClass_ReturnThis_RoundTripsSameInstance()
    {
        var source = """
            package p
            class Box[T] {
                var Value T
                init(v T) { Value = v }
                func Self() Box[T] {
                    return this
                }
            }
            func Main() {
                var b = Box[int32](42)
                var s = b.Self()
                System.Console.WriteLine(s.Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void GenericClass_ReturnNil_ProducesNullReference()
    {
        var source = """
            package p
            class Box[T] {
                func Nothing() Box[T] {
                    return nil
                }
            }
            func Main() {
                var b = Box[int32]()
                var n = b.Nothing()
                System.Console.WriteLine(n == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NonGenericClass_ReturnNil_ProducesNullReference()
    {
        var source = """
            package p
            class Box {
                func Nothing() Box {
                    return nil
                }
            }
            func Main() {
                var n = Box().Nothing()
                System.Console.WriteLine(n == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void NestedNullableSelfType_ReturnThis_RoundTripsValue()
    {
        var source = """
            package p
            class Box[T] {
                var Value T
                init(v T) { Value = v }
                func Wrapped() Box[T]? {
                    return this
                }
            }
            func Main() {
                var b = Box[int32](7)
                var w = b.Wrapped()
                System.Console.WriteLine(w != nil)
                System.Console.WriteLine(w!!.Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n7\n", output);
    }

    [Fact]
    public void PlainClass_EqualsNilAndNotEqualsNil_EvaluateCorrectly()
    {
        var source = """
            package p
            class Box {
                var X int32
                init(x int32) { X = x }
            }
            func Guard(b Box) bool {
                return b == nil
            }
            func Main() {
                var none Box = nil
                var some = Box(1)
                System.Console.WriteLine(Guard(none))
                System.Console.WriteLine(Guard(some))
                System.Console.WriteLine(some != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2354_exe_").FullName;
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
}
