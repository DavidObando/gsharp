// <copyright file="Issue1630VariadicCoercionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1630 — the variadic (<c>...T</c>) call-site pack/pass-through
/// protocol was hand-duplicated across ~7 binder call paths, and two of them
/// had drifted to pack raw, uncoerced elements instead of applying the
/// issue-#1493 per-element implicit conversion. This left
/// <c>f(1, 2, 3)</c> through a <c>(...int64) -> int64</c> function-typed
/// variable, and through a named-delegate variable of the same shape,
/// packing <c>int32</c>-typed literals directly into an <c>int64[]</c>
/// slice — invalid IL (caught by ilverify) rather than the widened
/// <c>int64</c> elements every other variadic call path already produced.
/// Both facets below exercise the two previously-broken call shapes with
/// trailing elements that need an implicit numeric widening, and assert the
/// widened values are actually summed (not merely that the call compiles).
/// </summary>
public class Issue1630VariadicCoercionEmitTests
{
    [Fact]
    public void EndToEnd_FunctionTypedVariableIndirectCall_CoercesElementsToInt64_Runs()
    {
        var source = """
            package Probe1630a
            import System

            func Main() {
                let f (...int64) -> int64 = (xs) -> xs[0] + xs[1] + xs[2]
                Console.WriteLine(f(1, 2, 3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegateDirectCall_CoercesElementsToInt64_Runs()
    {
        var source = """
            package Probe1630b
            import System

            type LongSumDelegate1630 = delegate func(xs ...int64) int64

            func Main() {
                var s LongSumDelegate1630 = (xs) -> xs[0] + xs[1] + xs[2]
                Console.WriteLine(s(1, 2, 3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1630_exe_").FullName;
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
