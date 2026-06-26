// <copyright file="Issue1174NestedTypeNameCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1174: a source-declared nested type whose simple name collides with a
/// same-named top-level type must remain referenceable via the qualified form
/// <c>Container.Nested</c> end-to-end — the constructed value's members resolve
/// against the NESTED type at runtime, including in a generic-argument position
/// (<c>List[C.E]</c>). Follow-up to #1080.
/// </summary>
public class Issue1174NestedTypeNameCollisionEmitTests
{
    [Fact]
    public void QualifiedNestedStructLiteral_UnderCollision_RunsAgainstNestedType()
    {
        var output = CompileAndRun("""
            package p

            import System

            class E { let Y int32 = 0 }

            class C { data struct E(X uint32) { } }

            func Main() {
                let e = C.E{X: 7u}
                Console.WriteLine(e.X)
            }
            """);

        Assert.Equal("7\n", output);
    }

    [Fact]
    public void QualifiedNestedInGenericArgument_UnderCollision_RoundTrips()
    {
        var output = CompileAndRun("""
            package p

            import System
            import System.Collections.Generic

            class E { let Y int32 = 0 }

            class C { data struct E(X uint32) { } }

            func Build() List[C.E] {
                let xs = List[C.E]()
                xs.Add(C.E{X: 5u})
                return xs
            }

            func Main() {
                let xs = Build()
                Console.WriteLine(xs[0].X)
            }
            """);

        Assert.Equal("5\n", output);
    }

    [Fact]
    public void DeepQualifiedChain_WithOuterHomonym_RunsAgainstNestedType()
    {
        var output = CompileAndRun("""
            package p

            import System

            class C { data struct E(X uint32) { } }

            class A { class B { data struct C(Z uint32) { } } }

            func Main() {
                let v = A.B.C{Z: 9u}
                Console.WriteLine(v.Z)
            }
            """);

        Assert.Equal("9\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1174_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

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
