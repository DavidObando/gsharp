// <copyright file="Adr0112UserMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0112 (unified member resolution): a user-defined type's <c>shared</c>
/// (static) or instance method may be converted to a delegate via a method
/// group — <c>Use(Box.Make)</c>, <c>Use(c.Get)</c>, and the bare implicit-this
/// forms. Emit must produce verifiable IL: a static group binds a null
/// delegate target (<c>ldnull; ldftn</c>), an instance group binds the receiver
/// (boxing value-type receivers), and an rvalue receiver is spilled to a local
/// by the slot planner so its address can be taken.
/// </summary>
public class Adr0112UserMethodGroupEmitTests
{
    [Fact]
    public void StaticMethodGroup_ViaTypeName_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            class Box {
                var tag int32
                shared {
                    func Make() Box { return Box{ tag: 7 } }
                }
            }

            func Use(f () -> Box) int32 { return f().tag }

            Console.WriteLine(Use(Box.Make))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethodGroup_ViaReceiver_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            class Counter {
                var n int32
                func Get() int32 { return n }
            }

            func Use(f () -> int32) int32 { return f() }

            var c = Counter{ n: 42 }
            Console.WriteLine(Use(c.Get))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void BareSharedMethodGroup_InsideMethod_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            class Factory {
                shared {
                    func Make() int32 { return 5 }
                }

                func Build() int32 {
                    var f () -> int32 = Make
                    return f()
                }
            }

            var fac = Factory{}
            Console.WriteLine(fac.Build())
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void BareInstanceMethodGroup_InsideMethod_CapturesThisAndRuns()
    {
        var source = """
            package P
            import System

            class Widget {
                var value int32
                func Read() int32 { return value }

                func AsDelegate() int32 {
                    var f () -> int32 = Read
                    return f()
                }
            }

            var w = Widget{ value: 9 }
            Console.WriteLine(w.AsDelegate())
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethodGroup_RvalueReceiver_SpillsAndRuns()
    {
        // The receiver is the rvalue result of a call, so the slot planner must
        // spill it into a local before the method-group emit can reference it.
        var source = """
            package P
            import System

            class Counter {
                var n int32
                func Get() int32 { return n }
            }

            func Make() Counter { return Counter{ n: 21 } }
            func Use(f () -> int32) int32 { return f() }

            Console.WriteLine(Use(Make().Get))
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0112_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute.
            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
