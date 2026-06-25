// <copyright file="Issue1124GenericUninferableOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1124: a method group containing a generic overload whose type
/// parameter cannot be inferred from the arguments (it appears only in the
/// return type / a constraint) alongside a non-generic overload with a matching
/// parameter list must, for a call without explicit type arguments, exclude the
/// generic candidate and bind the non-generic overload — previously this was
/// wrongly reported as GS0266 ambiguous.
/// <para>
/// These tests compile, IL-verify, and run the minimal repro end to end. The
/// non-generic overload returns a real <c>Box</c> (Tag = 99) while the generic
/// overload returns <c>default(T)</c> (null), so the runtime output proves which
/// overload was selected: the implicit call selects the non-generic overload
/// (prints 99), and an explicit type-argument list selects the generic overload
/// (returns null → prints -1).
/// </para>
/// </summary>
public class Issue1124GenericUninferableOverloadEmitTests
{
    [Fact]
    public void ImplicitCall_SelectsNonGenericOverload_EmitsAndRuns()
    {
        var source = """
            package p
            import System

            interface IBox {
                func Tag() int32;
            }

            class Box : IBox {
                func Tag() int32 { return 99 }
            }

            class Factory {
                shared {
                    func Make[T Box](file int32, parent IBox?) T { return default(T) }
                    func Make(file int32, parent IBox?) IBox { return Box() }
                }
            }

            class C {
                func runImplicit(b IBox) int32 {
                    let child = Factory.Make(5, b)
                    return child.Tag()
                }
            }

            var c = C()
            Console.WriteLine(c.runImplicit(Box()))
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitTypeArguments_SelectGenericOverload_EmitsAndRuns()
    {
        var source = """
            package p
            import System

            interface IBox {
                func Tag() int32;
            }

            class Box : IBox {
                func Tag() int32 { return 99 }
            }

            class Factory {
                shared {
                    func Make[T Box](file int32, parent IBox?) T? { return default(T) }
                    func Make(file int32, parent IBox?) IBox { return Box() }
                }
            }

            class C {
                func runImplicit(b IBox) int32 {
                    let child = Factory.Make(5, b)
                    return child.Tag()
                }

                func runExplicit(b IBox) int32 {
                    let child = Factory.Make[Box](5, b)
                    if child == nil {
                        return -1
                    }

                    return child.Tag()
                }
            }

            var c = C()
            Console.WriteLine(c.runImplicit(Box()))
            Console.WriteLine(c.runExplicit(Box()))
            """;

        Assert.Equal("99\n-1\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1124_emit_").FullName;
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
