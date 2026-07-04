// <copyright file="Issue2084VariadicCtorNamedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2084 — follow-up to #2069/#2081: the fixed-portion argument loop of
/// a variadic constructor's arg-binding (<c>OverloadResolver.cs</c>, "Convert/
/// validate the fixed-portion arguments first") had the same
/// <c>!Conversion.Classify(argument.Type, parameter.Type).IsImplicit</c>
/// fastpath as the 4 sites patched in #2081, but was the 5th, unpatched call
/// site. A func/arrow literal passed as a NAMED-delegate-typed FIXED
/// parameter ahead of a variadic tail (e.g. <c>init(h TickHandler, args
/// ...int32)</c>) skipped the forced conversion wrap, so the emitter
/// materialised the lambda against its natural <c>Action&lt;T&gt;</c> shape
/// instead of the named delegate's own emitted TypeDef.
/// </summary>
public class Issue2084VariadicCtorNamedDelegateEmitTests
{
    [Fact]
    public void EndToEnd_NamedDelegateLambdaArg_InVariadicCtorFixedPortion_Runs()
    {
        const string source = """
            package i2084variadicctor
            import System

            type TickHandler = delegate func(n int32) void

            class C {
                var H TickHandler
                var Sum int32

                init(h TickHandler, args ...int32) {
                    H = h
                    var s int32 = 0
                    for a in args {
                        s = s + a
                    }
                    Sum = s
                }
            }

            func Main() {
                var c = C((n int32) -> System.Console.WriteLine(n * 3), 1, 2, 3)
                c.H(7)
                System.Console.WriteLine(c.Sum)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("21\n6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2084_exe_").FullName;
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
