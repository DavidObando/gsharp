// <copyright file="Issue1570GenericOutParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1570 — calling a generic method that declares a <c>ref</c>/<c>out</c>
/// parameter whose type is a method (or containing) type parameter crashed emit
/// with <c>GS9998: InvalidOperationException: Cannot encode '*T' as a non-byref
/// signature slot</c>. The MethodSpec type-argument inference unified the open
/// type parameter against the argument's managed-pointer type (<c>T&amp;</c>)
/// and returned the byref itself as the inferred type argument; the MethodSpec
/// blob encoder then rejected the byref because a generic type argument can
/// never be a managed pointer.
/// <para>
/// The fix peels the <c>T&amp;</c> wrapper off both the formal and actual sides
/// during unification, so the inferred type argument is the pointee type. Each
/// test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed and leaks across tests.
/// </para>
/// </summary>
public class Issue1570GenericOutParamEmitTests
{
    [Fact]
    public void EndToEnd_GenericOutParam_OpenTypeParam_Runs()
    {
        const string source = """
            package i1570outopen
            import System

            class Holder {
                shared {
                    func TryMake[T](val T, out result T) bool {
                        result = val
                        return true
                    }
                }
            }

            func Make[T](v T) T {
                Holder.TryMake[T](v, out var result)
                return result
            }

            func Main() {
                System.Console.WriteLine(Make[int32](42))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_GenericOutParam_ConcreteTypeArg_Runs()
    {
        const string source = """
            package i1570concrete
            import System

            class Keeper {
                shared {
                    func TryMake[T](val T, out result T) bool {
                        result = val
                        return true
                    }
                }
            }

            func Main() {
                Keeper.TryMake[int32](7, out var result)
                System.Console.WriteLine(result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_GenericRefParam_OpenTypeParam_Runs()
    {
        const string source = """
            package i1570refopen
            import System

            class Mover {
                shared {
                    func Swap[T](src T, ref dst T) {
                        dst = src
                    }
                }
            }

            func Apply[T](v T, seed T) T {
                var r T = seed
                Mover.Swap[T](v, ref r)
                return r
            }

            func Main() {
                System.Console.WriteLine(Apply[int32](99, 0))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void EndToEnd_NonGenericOutParam_ControlStillWorks()
    {
        const string source = """
            package i1570control
            import System

            func TryGet(s string, out result int32) bool {
                result = 5
                return true
            }

            func Main() {
                TryGet("x", out var r)
                System.Console.WriteLine(r)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1570_exe_").FullName;
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
