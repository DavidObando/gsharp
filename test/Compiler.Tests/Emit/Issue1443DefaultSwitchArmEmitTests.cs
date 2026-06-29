// <copyright file="Issue1443DefaultSwitchArmEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1443 — a bare <c>default</c> used as a switch-expression arm result
/// (<c>case 0: default</c>) stayed an untyped <c>BoundDefaultExpression(Error)</c>
/// placeholder because arm results were bound without a target type. It then fell
/// into the conversion-failure branch and was silently replaced by a
/// <c>BoundErrorExpression</c>, crashing emission with GS9998. The fix re-binds the
/// bare-<c>default</c> arm against the switch's result type so it materialises as
/// <c>default(resultType)</c>, exactly like <c>default</c> in a return/arrow body.
/// </summary>
public class Issue1443DefaultSwitchArmEmitTests
{
    [Fact]
    public void EndToEnd_DefaultArmReturnsNullableUserClass_Runs()
    {
        var source = """
            package Probe1443a
            import System

            open class Thing1443a {
                prop Name string -> "thing"
            }

            func Pick(kind int32) Thing1443a? {
                return switch kind {
                    case 0: default
                    case 1: Thing1443a()
                    default: throw InvalidOperationException("bad")
                }
            }

            func Main() {
                Console.WriteLine(Pick(0) == nil)
                Console.WriteLine(Pick(1) != nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void EndToEnd_DefaultArmReturnsValueTypeZero_Runs()
    {
        var source = """
            package Probe1443b
            import System

            func Score(kind int32) int32 {
                return switch kind {
                    case 1: 10
                    case 2: 20
                    default: default
                }
            }

            func Main() {
                Console.WriteLine(Score(1))
                Console.WriteLine(Score(2))
                Console.WriteLine(Score(99))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n0\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1443_exe_").FullName;
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
