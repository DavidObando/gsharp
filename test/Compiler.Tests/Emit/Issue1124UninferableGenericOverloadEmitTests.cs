// <copyright file="Issue1124UninferableGenericOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1124: end-to-end CLR emit + ilverify + run coverage for a method
/// group containing a generic overload whose type parameter cannot be inferred
/// (it appears only in the return type / constraint) alongside a non-generic
/// overload with a matching parameter list. A call without explicit type
/// arguments must resolve to the non-generic overload (previously GS0266
/// ambiguity), while a call with explicit type arguments must resolve to the
/// generic overload. Both forms must emit a verifiable assembly that runs.
/// </summary>
public class Issue1124UninferableGenericOverloadEmitTests
{
    // Acceptance criterion 5: a program using the non-generic resolution
    // (Factory.Make(5, b)) compiles to a runnable assembly and produces the
    // non-generic overload's behavior (it returns a Box whose Tag() is "box").
    [Fact]
    public void EndToEnd_NoExplicitTypeArgs_RunsNonGenericOverload()
    {
        var source = """
            package Probe
            import System
            interface IBox { func Tag() string; }
            class Box : IBox { func Tag() string { return "box" } }
            class Factory {
                shared {
                    func Make[T Box](file int32, parent IBox?) T { return default(T) }
                    func Make(file int32, parent IBox?) IBox { return Box() }
                }
            }
            func Main() {
                var b IBox = Box()
                let child = Factory.Make(5, b)
                Console.WriteLine(child.Tag())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("box\n", output);
    }

    // Acceptance criterion 2 (emit): a call WITH explicit type arguments selects
    // the generic overload and the program emits a verifiable assembly that runs.
    [Fact]
    public void EndToEnd_ExplicitTypeArg_RunsGenericOverload()
    {
        var source = """
            package Probe
            import System
            interface IBox {}
            class Box : IBox {}
            class Factory {
                shared {
                    func Make[T Box](file int32, parent IBox?) T { return default(T) }
                    func Make(file int32, parent IBox?) IBox { return Box() }
                }
            }
            func Main() {
                var b IBox = Box()
                var made Box = Factory.Make[Box](5, b)
                Console.WriteLine("ok")
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1124_exe_").FullName;
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
