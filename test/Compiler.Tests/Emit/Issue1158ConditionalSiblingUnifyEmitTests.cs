// <copyright file="Issue1158ConditionalSiblingUnifyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1158: end-to-end CLR emit coverage for unifying two sibling-subtype
/// arms of an <c>if</c>/conditional-expression to their shared base type. The
/// upcast must be a no-op reference conversion, so the value flowing out of the
/// conditional keeps its concrete runtime type per the branch taken.
/// </summary>
public class Issue1158ConditionalSiblingUnifyEmitTests
{
    [Fact]
    public void EndToEnd_IfExpression_SiblingArms_PreservesConcreteType()
    {
        var source = """
            package Probe
            import System

            open class Box { }
            class Co64Box : Box { }
            class StcoBox : Box { }

            func PickIf(b bool) Box {
                let x = Co64Box()
                let y = StcoBox()
                return if b { x } else { y }
            }

            func Main() {
                Console.WriteLine(PickIf(true).GetType().Name)
                Console.WriteLine(PickIf(false).GetType().Name)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("Co64Box\nStcoBox\n", output);
    }

    [Fact]
    public void EndToEnd_Ternary_SiblingArms_PreservesConcreteType()
    {
        var source = """
            package Probe
            import System

            open class Box { }
            class Co64Box : Box { }
            class StcoBox : Box { }

            func PickTern(b bool) Box {
                let x = Co64Box()
                let y = StcoBox()
                return b ? x : y
            }

            func Main() {
                Console.WriteLine(PickTern(true).GetType().Name)
                Console.WriteLine(PickTern(false).GetType().Name)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("Co64Box\nStcoBox\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_cond1158_exe_").FullName;
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
