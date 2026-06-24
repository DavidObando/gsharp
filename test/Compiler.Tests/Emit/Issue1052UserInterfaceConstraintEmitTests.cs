// <copyright file="Issue1052UserInterfaceConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1052: end-to-end CLR emit + ilverify coverage for a generic
/// constrained by a USER-declared (non-sealed) interface. Validates that
/// instance-member dispatch through the constraint emits the verifiable
/// <c>constrained. !!T  callvirt IShape::Area()</c> sequence, that a
/// GenericParamConstraint metadata row is produced (so ilverify accepts the
/// assembly), and that the program runs and prints the expected value.
/// </summary>
public class Issue1052UserInterfaceConstraintEmitTests
{
    [Fact]
    public void EndToEnd_NonSealedUserInterfaceConstraint_DispatchesAndPrints9()
    {
        var source = """
            package p
            import System

            interface IShape { func Area() float64; }

            struct Sq : IShape {
                var S float64
                func Area() float64 { return S * S }
            }

            func Describe[T IShape](x T) float64 { return x.Area() }

            func Main() {
                Console.WriteLine(Describe[Sq](Sq{S: 3.0}))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("9\n", output);
    }

    [Fact]
    public void Library_NonSealedUserInterfaceConstraint_PassesIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; a missing
        // GenericParamConstraint row or a bare (un-constrained) callvirt would
        // fail verification here.
        var source = """
            package p

            interface IShape { func Area() float64; }

            struct Sq : IShape {
                var S float64
                func Area() float64 { return S * S }
            }

            func Describe[T IShape](x T) float64 { return x.Area() }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    [Fact]
    public void EndToEnd_SelfReferentialUserGenericInterfaceConstraint_Verifies()
    {
        // The `[T ICmp[T]]` shape over a user-declared generic interface.
        var source = """
            package p
            import System

            interface ICmp[T] { func CompareTo(other T) int32; }

            struct Num : ICmp[Num] {
                var V int32
                func CompareTo(other Num) int32 { return V - other.V }
            }

            func Bigger[T ICmp[T]](a T, b T) int32 { return a.CompareTo(b) }

            func Main() {
                Console.WriteLine(Bigger[Num](Num{V: 7}, Num{V: 3}))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1052_lib_").FullName;
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1052_exe_").FullName;
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
