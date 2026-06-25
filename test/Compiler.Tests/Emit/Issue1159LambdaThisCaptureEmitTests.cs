// <copyright file="Issue1159LambdaThisCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1159: a lambda body that makes an unqualified call to an
/// enclosing-instance method must capture <c>this</c> and dispatch through it
/// at runtime, producing the same value as an explicit <c>this.</c> call. These
/// end-to-end emit tests prove the captured receiver is actually used (not just
/// that the program compiles): the called instance method reads an instance
/// field, so a wrong/absent receiver would yield an incorrect value.
/// </summary>
public class Issue1159LambdaThisCaptureEmitTests
{
    [Fact]
    public void FuncLiteralLambda_CapturesThis_AndCallsInstanceMethod()
    {
        var source = """
            package P
            import System

            class C {
                var state int32 = 10
                func Bump(x int32) int32 { return x + state }
                func Run() {
                    let g = func (d int32) int32 { return Bump(d) }
                    Console.WriteLine(g(5))
                }
            }

            let c = C{ }
            c.Run()
            """;

        Assert.Equal("15\n", CompileAndRun(source));
    }

    [Fact]
    public void ArrowLambda_CapturesThis_AndCallsInstanceMethod()
    {
        var source = """
            package P
            import System

            class C {
                var state int32 = 100
                func Bump(x int32) int32 { return x + state }
                func Run() {
                    let g = (d int32) -> Bump(d)
                    Console.WriteLine(g(7))
                }
            }

            let c = C{ }
            c.Run()
            """;

        Assert.Equal("107\n", CompileAndRun(source));
    }

    [Fact]
    public void NestedLambda_CapturesThis_AndCallsInstanceMethod()
    {
        var source = """
            package P
            import System

            class C {
                var state int32 = 20
                func Bump(x int32) int32 { return x + state }
                func Run() {
                    let g = func (d int32) int32 {
                        let inner = func (e int32) int32 { return Bump(e) }
                        return inner(d)
                    }
                    Console.WriteLine(g(3))
                }
            }

            let c = C{ }
            c.Run()
            """;

        Assert.Equal("23\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1159_emit_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
