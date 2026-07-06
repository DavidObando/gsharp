// <copyright file="Issue2165IsInterfaceNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2165: end-to-end CLR emit + ilverify coverage proving that an
/// <c>is</c>-interface smart cast on a TYPE PARAMETER or INTERFACE operand
/// narrows the operand so the tested interface's member is actually invoked at
/// runtime (not just resolved at bind time).
/// </summary>
public class Issue2165IsInterfaceNarrowingEmitTests
{
    [Fact]
    public void EndToEnd_IsInterface_OnInterfaceOperand_InvokesInterfaceMember()
    {
        var source = """
            package p
            interface IInit {
                func Init() int32;
            }
            interface IShape {
                func Area() int32;
            }
            class Circle : IShape, IInit {
                func Area() int32 { return 2 }
                func Init() int32 { return 41 }
            }
            func Probe(x IShape) int32 {
                if x is IInit {
                    return x.Init()
                }
                return -1
            }
            func Main() {
                System.Console.WriteLine(Probe(Circle()))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("41\n", output);
    }

    [Fact]
    public void EndToEnd_IsInterface_OnTypeParameterOperand_InvokesInterfaceMember()
    {
        var source = """
            package p
            interface IInit {
                func Init() int32;
            }
            class Circle : IInit {
                func Init() int32 { return 7 }
            }
            func Probe[T](x T) int32 {
                if x is IInit {
                    return x.Init()
                }
                return -1
            }
            func Main() {
                System.Console.WriteLine(Probe[Circle](Circle()))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2165_exe_").FullName;
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
}
