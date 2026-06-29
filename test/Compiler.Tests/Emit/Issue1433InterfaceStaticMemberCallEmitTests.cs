// <copyright file="Issue1433InterfaceStaticMemberCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1433 — calling a static (<c>shared</c>) member declared on a
/// user-defined <c>interface</c>. Before the fix the binder produced no
/// resolution for <c>IName.Method(args)</c> (and interface static property
/// reads / method groups), leaking a <see cref="GSharp.Core.CodeAnalysis.Binding.BoundErrorExpression"/>
/// into emit which crashed with a misleading <c>GS0268</c> ("for-in loop")
/// internal compiler error. These tests cover the generalized fix: interface
/// static method calls (used + discarded), a static method group, a static
/// property read, and a constructed generic interface static method call,
/// validated end-to-end (compile + run). Every user type is uniquely named so
/// the process-wide <c>FunctionTypeSymbol</c> cache cannot alias across tests.
/// </summary>
public class Issue1433InterfaceStaticMemberCallEmitTests
{
    [Fact]
    public void EndToEnd_InterfaceStaticMethodCall_UsedAndDiscarded_Runs()
    {
        var source = """
            package Probe1433a
            import System

            interface IThingA1433 {
                prop Name string { get; }
                shared {
                    func Create(n int32) IThingA1433 {
                        return ThingA1433(n)
                    }
                }
            }

            class ThingA1433(N int32) : IThingA1433 {
                prop Name string -> "t${N}"
            }

            func Main() {
                let t = IThingA1433.Create(7)
                Console.WriteLine(t.Name)
                IThingA1433.Create(99)
                Console.WriteLine("done")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("t7\ndone\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceStaticMethodOverloads_AndArgumentPosition_Runs()
    {
        var source = """
            package Probe1433b
            import System

            interface IFactoryB1433 {
                shared {
                    func Make() string {
                        return "none"
                    }
                    func Make(n int32) string {
                        return "int${n}"
                    }
                    func Make(s string) string {
                        return "str${s}"
                    }
                }
            }

            func Use(value string) string -> value

            func Main() {
                Console.WriteLine(IFactoryB1433.Make())
                Console.WriteLine(IFactoryB1433.Make(5))
                Console.WriteLine(Use(IFactoryB1433.Make("x")))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("none\nint5\nstrx\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceStaticProperty_Read_Runs()
    {
        var source = """
            package Probe1433c
            import System

            sealed interface IDataC1433 {
                shared {
                    prop Origin string { get { return "origin" } }
                }
            }

            func Main() {
                Console.WriteLine(IDataC1433.Origin)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("origin\n", output);
    }

    [Fact]
    public void EndToEnd_ConstructedGenericInterfaceStaticMethodCall_Runs()
    {
        var source = """
            package Probe1433e
            import System

            interface IBoxE1433[T] {
                shared {
                    func Tag() int32 {
                        return 7
                    }
                }
            }

            func Main() {
                Console.WriteLine(IBoxE1433[int32].Tag())
                Console.WriteLine(IBoxE1433[string].Tag())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n7\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceStaticMethodCall_InReturnPosition_Runs()
    {
        var source = """
            package Probe1433f
            import System

            interface IThingF1433 {
                prop Name string { get; }
                shared {
                    func Create(n int32) IThingF1433 {
                        return ThingF1433(n)
                    }
                }
            }

            class ThingF1433(N int32) : IThingF1433 {
                prop Name string -> "f${N}"
            }

            func Build() IThingF1433 -> IThingF1433.Create(3)

            func Main() {
                Console.WriteLine(Build().Name)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("f3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1433_exe_").FullName;
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

            IlVerifier.Verify(dllPath, ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface);

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
