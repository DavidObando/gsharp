// <copyright file="Issue1139StaticOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1139 (follow-up to #1133): an inline <c>out var n</c> declaration at a
/// <em>qualified static</em> call site (<c>C.G(out var n)</c>) was bound with
/// <c>TypeSymbol.Error</c> before overload resolution and never leaked the local
/// into the enclosing scope, so a later read failed with <c>GS0125</c>. #1137
/// fixed the user-instance path; this verifies the qualified-static path
/// (<c>BindUserTypeStaticCall</c>) compiles, IL-verifies, and runs end-to-end.
/// </summary>
public class Issue1139StaticOutVarEmitTests
{
    [Fact]
    public void QualifiedStatic_OutVar_Compiles_And_Runs()
    {
        // The headline repro: `C.G(out var y)` in an `if` condition must declare
        // `y` in the enclosing scope and return 13.
        var source = """
            package P
            import System

            class C {
                shared {
                    func G(out x int32) bool {
                        x = 13
                        return true
                    }
                }
                func F() int32 {
                    if C.G(out var y) {
                        return y
                    }
                    return 0
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("13\n", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedStatic_GenericOutParameter_OutVar_Compiles_And_Runs()
    {
        // A generic out-parameter on a static method must bind the out-var local
        // as the substituted pointee type (int32) and run.
        var source = """
            package P
            import System

            class C {
                shared {
                    func M[T](seed T, out result T) { result = seed }
                }
                func F() int32 {
                    C.M[int32](21, out var y)
                    return y
                }
            }

            var c = C()
            Console.WriteLine(c.F())
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1139_emit_").FullName;
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
