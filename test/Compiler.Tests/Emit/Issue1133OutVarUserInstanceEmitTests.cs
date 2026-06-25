// <copyright file="Issue1133OutVarUserInstanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1133: an inline <c>out var n</c> (and <c>out let n</c> / <c>out _</c>)
/// declaration at a <em>user instance method</em> call site was accepted but the
/// declared local never leaked into the enclosing block scope, so a later read
/// failed with <c>GS0125</c>. The free-function and imported-method paths already
/// re-bound the first-pass placeholder once overload resolution had chosen the
/// callee; <c>BindUserInstanceCall</c> did not. These tests compile, IL-verify,
/// and actually run the shape end-to-end so the leaked local both binds and
/// carries the right value at runtime.
/// </summary>
public class Issue1133OutVarUserInstanceEmitTests
{
    [Fact]
    public void ImplicitThis_OutVar_Compiles_And_Runs()
    {
        // The headline repro: `G(out var y)` on an implicit-`this` instance
        // method must declare `y` in the enclosing scope and return 5.
        var source = """
            package P
            import System

            class C {
                func G(out x int32) { x = 5 }
                func F() int32 {
                    G(out var y)
                    return y
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitReceiver_OutVar_Compiles_And_Runs()
    {
        // `c.G(out var y)` on an explicit receiver must leak `y` too.
        var source = """
            package P
            import System

            class C {
                func G(out x int32) { x = 7 }
            }

            class D {
                func F(c C) int32 {
                    c.G(out var y)
                    return y
                }
            }

            var c = C()
            var d = D()
            Console.WriteLine(d.F(c))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void OutLet_ReadOnlyLocal_Compiles_And_Runs()
    {
        // `out let y` declares a read-only local; reading it is fine.
        var source = """
            package P
            import System

            class C {
                func G(out x int32) { x = 11 }
                func F() int32 {
                    G(out let y)
                    return y
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void OutDiscard_Compiles_And_Runs()
    {
        // `out _` discards the result; no name leaks into the enclosing scope.
        var source = """
            package P
            import System

            class C {
                func G(out x int32) { x = 5 }
                func F() int32 {
                    G(out _)
                    return 42
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericOutParameter_OutVar_Compiles_And_Runs()
    {
        // A generic out-parameter (`func M[T](seed T, out result T)`) must bind
        // the out-var local as the substituted pointee type (int32) and run.
        var source = """
            package P
            import System

            class C {
                func M[T](seed T, out result T) { result = seed }
                func F() int32 {
                    M[int32](9, out var y)
                    return y
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedStatic_OutVar_Compiles_And_Runs()
    {
        // Issue #1139: the qualified static (`C.G(out var y)`) path was missed
        // by #1137. The leaked local must both bind and carry the runtime value.
        var source = """
            package P
            import System

            class C {
                shared {
                    func G(out x int32) { x = 13 }
                    func F() int32 {
                        C.G(out var y)
                        return y
                    }
                }
            }

            Console.WriteLine(C.F())
            """;

        Assert.Equal("13\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1133_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
