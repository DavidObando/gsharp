// <copyright file="Issue1112SwitchBestCommonTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1112: a switch-expression no longer forces every arm to produce the
/// exact same type. The result type is the best-common-type (least-upper-bound)
/// across all arm types — the shared base class or interface. These tests
/// compile, ilverify, and RUN the repro to prove the upcast arms dispatch
/// correctly at runtime.
/// </summary>
public class Issue1112SwitchBestCommonTypeEmitTests
{
    [Fact]
    public void EndToEnd_SiblingSubtypes_SwitchBindsToBaseAndDispatches()
    {
        // The repro: each arm produces a distinct subtype of Base; the switch
        // result type is the shared base class Base. Virtual dispatch on the
        // upcast value resolves to the runtime subtype's override.
        var source = """
            package p

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
                func PickReturn(s string) Base {
                    return switch s {
                        case "a": A()
                        case "b": B()
                        default: A()
                    }
                }
            }

            func Main() {
                let f = Factory()
                System.Console.WriteLine(f.PickReturn("a").Name())
                System.Console.WriteLine(f.PickReturn("b").Name())
                System.Console.WriteLine(f.PickLet("a").Name())
                System.Console.WriteLine(f.PickLet("b").Name())
                System.Console.WriteLine(f.PickReturn("z").Name())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("a\nb\na\nb\na\n", output);
    }

    [Fact]
    public void EndToEnd_SharedInterface_SwitchBindsToInterfaceAndDispatches()
    {
        // Arms implement a common interface (no shared base beyond object); the
        // switch result type is the interface and dispatch resolves correctly.
        var source = """
            package p

            interface IShape { func Kind() string; }
            class Circle : IShape { func Kind() string { return "circle" } }
            class Square : IShape { func Kind() string { return "square" } }

            class Picker {
                func Pick(s string) IShape {
                    return switch s {
                        case "c": Circle()
                        default: Square()
                    }
                }
            }

            func Main() {
                let p = Picker()
                System.Console.WriteLine(p.Pick("c").Kind())
                System.Console.WriteLine(p.Pick("s").Kind())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("circle\nsquare\n", output);
    }

    [Fact]
    public void EndToEnd_NeverArm_DoesNotConstrainAndDispatches()
    {
        // A throw-expression arm has the bottom (never) type; it does not
        // constrain the best-common-type, which is the shared base Base.
        var source = """
            package p

            open class Base { open func Name() string { return "base" } }
            class A : Base { override func Name() string { return "a" } }
            class B : Base { override func Name() string { return "b" } }

            class Factory {
                func Pick(s string) Base {
                    return switch s {
                        case "a": A()
                        case "b": throw System.Exception("boom")
                        default: B()
                    }
                }
            }

            func Main() {
                let f = Factory()
                System.Console.WriteLine(f.Pick("a").Name())
                System.Console.WriteLine(f.Pick("z").Name())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("a\nb\n", output);
    }

    [Fact]
    public void Library_SwitchBestCommonType_PassesIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; an unsound
        // upcast or a missing conversion would fail verification here.
        var source = """
            package p

            open class Base { open func Name() string { return "base" } }
            class A : Base { override func Name() string { return "a" } }
            class B : Base { override func Name() string { return "b" } }

            class Factory {
                func Pick(s string) Base {
                    return switch s { case "a": A() case "b": B() default: A() }
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1112_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1112_exe_").FullName;
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

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
