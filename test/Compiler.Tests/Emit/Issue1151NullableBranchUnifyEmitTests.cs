// <copyright file="Issue1151NullableBranchUnifyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1151: end-to-end CLR emit coverage for unifying a value-type arm and
/// a <c>nil</c> arm of an <c>if</c>/<c>switch</c>-expression to <c>T?</c>. The
/// emitted nullable must round-trip: the present branch yields a
/// <c>Nullable&lt;T&gt;</c> with a value, and the <c>nil</c> branch yields the
/// missing-value <c>Nullable&lt;T&gt;</c> (lowered to a <c>default(T?)</c> temp
/// slot), and ilverify must accept the assembly.
/// </summary>
public class Issue1151NullableBranchUnifyEmitTests
{
    [Fact]
    public void EndToEnd_IfExpression_ValueTypeAndNil_RoundTrips()
    {
        var source = """
            package Probe
            import System

            class Box {
                func F(present bool) int32? {
                    let x = if present { 5 } else { nil }
                    return x
                }
            }

            func Main() {
                var b = Box()
                Console.WriteLine(Describe(b.F(true)))
                Console.WriteLine(Describe(b.F(false)))
            }

            func Describe(v int32?) int32 {
                return v ?? -1
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("5\n-1\n", output);
    }

    [Fact]
    public void EndToEnd_IfExpression_TargetTyped_ValueTypeAndNil_RoundTrips()
    {
        var source = """
            package Probe
            import System

            class Box {
                func G(present bool) int32? {
                    let x int32? = if present { 5 } else { nil }
                    return x
                }
            }

            func Main() {
                var b = Box()
                Console.WriteLine(Describe(b.G(true)))
                Console.WriteLine(Describe(b.G(false)))
            }

            func Describe(v int32?) int32 {
                return v ?? -1
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("5\n-1\n", output);
    }

    [Fact]
    public void EndToEnd_SwitchExpression_ValueTypeAndNil_RoundTrips()
    {
        var source = """
            package Probe
            import System

            class Box {
                func S(present bool) int32? {
                    let x = switch present { case true: 42 default: nil }
                    return x
                }
            }

            func Main() {
                var b = Box()
                Console.WriteLine(Describe(b.S(true)))
                Console.WriteLine(Describe(b.S(false)))
            }

            func Describe(v int32?) int32 {
                return v ?? -1
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("42\n-1\n", output);
    }

    [Fact]
    public void EndToEnd_Mpeg4StyleUInt32AndNil_RoundTrips()
    {
        var source = """
            package Probe
            import System

            class Reader {
                func Field(present bool) uint32? {
                    let v = if present { 123u } else { nil }
                    return v
                }
            }

            func Main() {
                var r = Reader()
                Console.WriteLine(Describe(r.Field(true)))
                Console.WriteLine(Describe(r.Field(false)))
            }

            func Describe(v uint32?) uint32 {
                return v ?? 999u
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("123\n999\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_nil1151_exe_").FullName;
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
