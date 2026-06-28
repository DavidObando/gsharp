// <copyright file="Issue1397InterfaceMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1397: a method accessed as a method group on an interface-typed
/// receiver must lower to a delegate over an interface dispatch so invoking it
/// reaches the concrete implementation. Emit must be verifiable and the
/// delegate must invoke through the interface (ldvirtftn), including for a
/// method inherited from a base interface.
/// </summary>
public class Issue1397InterfaceMethodGroupEmitTests
{
    [Fact]
    public void InterfaceMethodGroup_ToDelegate_DispatchesAndRuns()
    {
        var source = """
            package P
            import System

            interface IReader { func Run(x int32) int32; }
            class Reader : IReader { func Run(x int32) int32 -> x * 10 }

            func Use(r IReader) int32 {
                let d (int32) -> int32 = r.Run
                return d(5)
            }

            Console.WriteLine(Use(Reader()))
            """;

        Assert.Equal("50\n", CompileAndRun(source));
    }

    [Fact]
    public void InheritedInterfaceMethodGroup_ToDelegate_DispatchesAndRuns()
    {
        var source = """
            package P
            import System

            interface IBase { func Run(x int32) int32; }
            interface IReader : IBase {}
            class Reader : IReader { func Run(x int32) int32 -> x + 1 }

            func Use(r IReader) int32 {
                let d (int32) -> int32 = r.Run
                return d(41)
            }

            Console.WriteLine(Use(Reader()))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1397_emit_").FullName;
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
