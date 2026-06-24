// <copyright file="Issue1051GenericArityTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1051: a type and a same-named generic of a different arity
/// (<c>Foo</c> and <c>Foo[T]</c>, mirroring <c>Task</c>/<c>Task&lt;T&gt;</c>)
/// coexist as distinct types keyed by (name, arity). The CLR mangles a generic
/// type's metadata name with the backtick-arity suffix (<c>Foo`1</c>) while the
/// arity-0 type keeps the bare name, so both emit to distinct TypeDefs and the
/// produced assembly is valid and runs.
/// </summary>
public class Issue1051GenericArityTypesEmitTests
{
    [Fact]
    public void Arity0AndArityNSameName_EmitsAndRuns()
    {
        var source = """
            package p
            open class Box { func A() int32 { return 1 } }
            open class Box[T] : Box { var V T }
            func Main() {
                let a = Box()
                let b = Box[int32]{V: 5}
                System.Console.WriteLine(a.A() + b.V)
            }
            """;

        Assert.Equal("6\n", CompileAndRun(source));
    }

    [Fact]
    public void SameNamedInterfaceAndGenericInterface_EmitsAndRuns()
    {
        var source = """
            package p
            import System

            interface I { func Tag() int32; }
            interface I[T] { func Wrap(v T) T; }

            class C : I { func Tag() int32 { return 7 } }
            class D[T] : I[T] { func Wrap(v T) T { return v } }

            func Main() {
                let c = C{}
                let d = D[int32]{}
                Console.WriteLine(c.Tag() + d.Wrap(3))
            }
            """;

        Assert.Equal("10\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1051_emit_").FullName;
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
