// <copyright file="Issue1112SwitchExprCommonTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1112: end-to-end CLR emit coverage for switch-expression
/// best-common-type / target-typing. A switch-expression whose arms produce
/// different derived types (sharing a common base class or interface) must
/// unify to that base/interface, both when the result is inferred into a
/// local and when it is returned directly from a typed function. The emitted
/// switch must produce a value statically typed as the common type so the
/// stack slot / local is uniform, and ilverify must accept the assembly.
/// </summary>
public class Issue1112SwitchExprCommonTypeEmitTests
{
    [Fact]
    public void EndToEnd_CommonBaseClass_LetInference_RunsAndDispatchesVirtually()
    {
        var source = """
            package Probe
            import System

            open class Base {
                open func Name() string { return "base" }
            }
            class A : Base {
                override func Name() string { return "a" }
            }
            class B : Base {
                override func Name() string { return "b" }
            }

            class Factory {
                func PickLet(s string) Base {
                    let box = switch s {
                        case "a": A()
                        case "b": B()
                        default: A()
                    }
                    return box
                }
            }

            func Main() {
                var f = Factory()
                Console.WriteLine(f.PickLet("a").Name())
                Console.WriteLine(f.PickLet("b").Name())
                Console.WriteLine(f.PickLet("z").Name())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("a\nb\na\n", output);
    }

    [Fact]
    public void EndToEnd_CommonBaseClass_DirectReturn_RunsAndDispatchesVirtually()
    {
        var source = """
            package Probe
            import System

            open class Base {
                open func Name() string { return "base" }
            }
            class A : Base {
                override func Name() string { return "a" }
            }
            class B : Base {
                override func Name() string { return "b" }
            }

            class Factory {
                func PickReturn(s string) Base {
                    return switch s {
                        case "a": A()
                        case "b": B()
                        default: A()
                    }
                }
            }

            func Main() {
                var f = Factory()
                Console.WriteLine(f.PickReturn("a").Name())
                Console.WriteLine(f.PickReturn("b").Name())
                Console.WriteLine(f.PickReturn("z").Name())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("a\nb\na\n", output);
    }

    [Fact]
    public void EndToEnd_CommonInterface_RunsAndDispatchesVirtually()
    {
        var source = """
            package Probe
            import System

            interface IShape {
                func Area() float64;
            }
            class Sq : IShape {
                func Area() float64 { return 4.0 }
            }
            class Ci : IShape {
                func Area() float64 { return 3.0 }
            }

            class Factory {
                func Pick(s string) IShape {
                    let box = switch s {
                        case "sq": Sq()
                        default: Ci()
                    }
                    return box
                }
            }

            func Main() {
                var f = Factory()
                Console.WriteLine(f.Pick("sq").Area())
                Console.WriteLine(f.Pick("ci").Area())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("4\n3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_sw1112_exe_").FullName;
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
