// <copyright file="Issue1439NullConditionalFieldInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1439 — the null-conditional delegate invocation shorthand
/// <c>field?(args)</c> on a nullable-delegate INSTANCE field. The receiver
/// load in <c>OverloadResolver.TryBindNullableDelegateInvocation</c> went
/// through <c>TryBuildImplicitMemberLoad</c>, which did not handle
/// <c>ImplicitFieldVariableSymbol</c> and fell back to a bare local load —
/// crashing emit with GS9998 "Variable '&lt;field&gt;' has no local slot".
/// The fix teaches <c>TryBuildImplicitMemberLoad</c> to load an instance
/// field as <c>this.field</c>, so every caller (and the explicit
/// <c>field?.Invoke(args)</c> form, which already worked) behaves the same.
/// </summary>
public class Issue1439NullConditionalFieldInvokeEmitTests
{
    [Fact]
    public void EndToEnd_NullConditionalInvokeOnNonNullField_Runs()
    {
        var source = """
            package Probe1439a
            import System

            open class Sink1439a {
                private let cb ((int32) -> void)?
                init(cb ((int32) -> void)?) { this.cb = cb }
                open func Fire(n int32) {
                    cb?(n)
                }
            }

            func Main() {
                var total = 0
                let s = Sink1439a((n int32) -> { total = total + n })
                s.Fire(5)
                s.Fire(7)
                Console.WriteLine(total)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void EndToEnd_NullConditionalInvokeOnNilField_IsNoOp()
    {
        var source = """
            package Probe1439b
            import System

            open class Sink1439b {
                private let cb ((int32) -> void)?
                init(cb ((int32) -> void)?) { this.cb = cb }
                open func Fire(n int32) {
                    cb?(n)
                }
            }

            func Main() {
                let s = Sink1439b(nil)
                s.Fire(5)
                Console.WriteLine("done")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("done\n", output);
    }

    [Fact]
    public void EndToEnd_NullConditionalInvokeWithReturnValueField_Runs()
    {
        var source = """
            package Probe1439c
            import System

            open class Calc1439c {
                private let fn ((int32) -> int32)?
                init(fn ((int32) -> int32)?) { this.fn = fn }
                open func Apply(n int32) int32? {
                    return fn?(n)
                }
            }

            func Main() {
                let c = Calc1439c((n int32) -> n * 2)
                Console.WriteLine(c.Apply(21) ?? -1)
                let none = Calc1439c(nil)
                Console.WriteLine(none.Apply(21) ?? -1)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n-1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1439_exe_").FullName;
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
