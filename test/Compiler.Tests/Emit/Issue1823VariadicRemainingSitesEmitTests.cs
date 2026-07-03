// <copyright file="Issue1823VariadicRemainingSitesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1823 — follow-up to #1630. That fix extracted
/// <c>PackOrPassThroughVariadicArguments</c> in <c>OverloadResolver</c> and
/// routed the 7 variadic pack sites there through it, but three sibling
/// sites OUTSIDE <c>OverloadResolver</c> still packed raw, uncoerced trailing
/// elements: a struct field of function type invoked directly
/// (<c>TryBindUserStructDelegateFieldInvocation</c>), a named-CLR-delegate
/// <c>.Invoke(args)</c> call (<c>BindNamedDelegateInvokeCall</c>), and a
/// generic static method fallback with type-argument substitution
/// (<c>BindUserTypeStaticCall</c>). Each case below packs an <c>int32</c>
/// element into a variadic <c>...int64</c> slot — a widening conversion the
/// #1493/#1630 per-element coercion is supposed to guarantee — and asserts
/// the widened value is actually observed at runtime (not merely that the
/// call compiles/verifies).
/// </summary>
public class Issue1823VariadicRemainingSitesEmitTests
{
    [Fact]
    public void EndToEnd_StructFieldOfFunctionTypeDirectCall_CoercesElementsToInt64_Runs()
    {
        var source = """
            package Probe1823a
            import System

            class Container1823a {
                var callback (...int64) -> int64

                init(cb (...int64) -> int64) {
                    this.callback = cb
                }
            }

            func Main() {
                let cb (...int64) -> int64 = (xs) -> xs[0] + xs[1] + xs[2]
                let c = Container1823a(cb)
                Console.WriteLine(c.callback(1, 2, 3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegateInvokeMemberCall_CoercesElementsToInt64_Runs()
    {
        var source = """
            package Probe1823b
            import System

            type LongSumDelegate1823 = delegate func(xs ...int64) int64

            func Main() {
                var s LongSumDelegate1823 = (xs) -> xs[0] + xs[1] + xs[2]
                Console.WriteLine(s.Invoke(1, 2, 3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void EndToEnd_GenericStaticMethodFallbackWithSubstitution_CoercesElementsToInt64_Runs()
    {
        var source = """
            package Probe1823c
            import System

            class Utils1823c {
                shared {
                    func First[T any](xs ...T) T {
                        return xs[0]
                    }
                }
            }

            func Main() {
                var a int32 = 1
                var b int32 = 2
                var c int32 = 3
                Console.WriteLine(Utils1823c.First[int64](a, b, c))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1823_exe_").FullName;
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
