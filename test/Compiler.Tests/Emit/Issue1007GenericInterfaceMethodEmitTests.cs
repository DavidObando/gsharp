// <copyright file="Issue1007GenericInterfaceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1007: a generic method declared inside an interface body —
/// <c>func Echo[T](x T) T;</c> — failed to parse, even though generic methods
/// parse fine on classes and as free functions. After the fix the
/// interface-member parser accepts the type-parameter list, the binder records
/// the method's generic arity, and the emitter writes a proper CLR generic
/// abstract slot (signature genericParameterCount + per-method
/// <c>GenericParam</c> rows). These tests compile and run an end-to-end
/// scenario where a class implements the generic interface method and a
/// top-level program invokes it through an interface-typed reference with an
/// explicit type argument, verifying behavior and that the emitted IL passes
/// <c>ilverify</c>.
/// </summary>
public class Issue1007GenericInterfaceMethodEmitTests
{
    [Fact]
    public void GenericInterfaceMethod_SingleTypeArg_ImplementedAndInvoked_Runs()
    {
        var source = """
            package P
            import System

            interface A {
                func Echo[T](x T) T;
            }

            class C : A {
                func Echo[T](x T) T { return x }
            }

            var a A = C()
            Console.WriteLine(a.Echo[int32](42))
            Console.WriteLine(a.Echo[string]("hi"))
            """;

        Assert.Equal("42\nhi\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterfaceMethod_MultipleTypeArgs_ImplementedAndInvoked_Runs()
    {
        var source = """
            package P
            import System

            interface A {
                func Pair[T, U](a T, b U) U;
            }

            class C : A {
                func Pair[T, U](a T, b U) U { return b }
            }

            var a A = C()
            Console.WriteLine(a.Pair[int32, string](1, "ok"))
            """;

        Assert.Equal("ok\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterfaceMethod_NoParameters_ReturnsTypeArg_Runs()
    {
        // A bodyless generic interface method with no value parameters whose
        // type argument is supplied explicitly at the call site.
        var source = """
            package P
            import System

            interface A {
                func Make[T](seed T) T;
            }

            class C : A {
                func Make[T](seed T) T { return seed }
            }

            var a A = C()
            Console.WriteLine(a.Make[int32](7))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericInterfaceMethod_ArityMismatchImplementation_StillRejectedGS0187()
    {
        // Negative guard: a same-name non-generic class method must not be
        // treated as implementing the generic interface slot.
        var source = """
            package P

            interface A { func Echo[T](x T) T; }

            class C : A {
                func Echo(x int32) int32 { return x }
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0187"));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1007_emit_").FullName;
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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1007_neg_").FullName;
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
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
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
