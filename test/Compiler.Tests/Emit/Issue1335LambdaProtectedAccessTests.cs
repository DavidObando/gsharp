// <copyright file="Issue1335LambdaProtectedAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1335 — a <c>protected</c>/<c>private</c> member of the enclosing class
/// referenced from inside a lambda / function-literal declared in the same class
/// must have the same access as the enclosing member (matching C#). Previously
/// the bind-time accessibility check lost the enclosing-type context inside a
/// closure body and wrongly reported <c>GS0379</c>. These tests pin the fix:
/// protected, private, field, property, and inherited-protected access all
/// compile and run from a closure (including nested closures), while genuine
/// inaccessibility (a protected member of an unrelated class) still reports
/// <c>GS0379</c>.
/// </summary>
public class Issue1335LambdaProtectedAccessTests
{
    [Fact]
    public void Lambda_CallsProtectedAndPrivateMember_Runs()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue1335.Tests

            import System

            open class C {
                protected func Prot() int32 {
                    return 13
                }
                private func Priv() int32 {
                    return 11
                }
                func F() int32 {
                    let g = func () int32 { return Prot() + Priv() }
                    return g()
                }
            }

            func Main() {
                let c = C{}
                Console.WriteLine(c.F())
            }
            """,
            "24\n");
    }

    [Fact]
    public void Lambda_ReadsProtectedPropertyAndPrivateField_Runs()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue1335.Tests

            import System

            open class C {
                private var f int32
                protected prop P int32 { get { return 9 } }
                func F() int32 {
                    f = 5
                    let g = func () int32 { return f + P }
                    return g()
                }
            }

            func Main() {
                let c = C{}
                Console.WriteLine(c.F())
            }
            """,
            "14\n");
    }

    [Fact]
    public void Lambda_CallsInheritedProtectedMember_Runs()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue1335.Tests

            import System

            open class Base {
                protected func BaseHelper() int32 {
                    return 7
                }
            }

            open class Derived : Base {
                func F() int32 {
                    let g = func () int32 { return BaseHelper() }
                    return g()
                }
            }

            func Main() {
                let d = Derived{}
                Console.WriteLine(d.F())
            }
            """,
            "7\n");
    }

    [Fact]
    public void NestedLambda_CallsProtectedAndPrivateMember_Runs()
    {
        CompileVerifyAndRun(
            """
            package Maui.Issue1335.Tests

            import System

            open class C {
                protected func Prot() int32 {
                    return 13
                }
                private func Priv() int32 {
                    return 11
                }
                func F() int32 {
                    let outer = func () int32 {
                        let inner = func () int32 { return Prot() + Priv() }
                        return inner()
                    }
                    return outer()
                }
            }

            func Main() {
                let c = C{}
                Console.WriteLine(c.F())
            }
            """,
            "24\n");
    }

    [Fact]
    public void Lambda_AccessesUnrelatedClassProtectedMember_FailsToCompile()
    {
        var (exit, output) = TryCompile(
            """
            package Maui.Issue1335.Tests

            import System

            open class Other {
                protected func Secret() int32 {
                    return 1
                }
            }

            class C {
                func F() int32 {
                    let o = Other{}
                    let g = func () int32 { return o.Secret() }
                    return g()
                }
            }

            func Main() {
                let c = C{}
                Console.WriteLine(c.F())
            }
            """);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0379", output);
    }

    private static void CompileVerifyAndRun(string source, string expected)
    {
        var dll = CompileToDll(source);
        try
        {
            IlVerifier.Verify(dll);

            var runtimeConfigPath = Path.ChangeExtension(dll, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + dll + "\"")
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

            Assert.Equal(expected, stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            TryDeleteDir(Path.GetDirectoryName(dll));
        }
    }

    private static string CompileToDll(string source)
    {
        var (exit, output, outPath) = RunCompiler(source);
        Assert.True(exit == 0, $"compile failed ({exit}): {output}");
        return outPath;
    }

    private static (int Exit, string Output) TryCompile(string source)
    {
        var (exit, output, outDir) = RunCompiler(source);
        TryDeleteDir(Path.GetDirectoryName(outDir));
        return (exit, output);
    }

    private static (int Exit, string Output, string OutPath) RunCompiler(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1335_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
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
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (compileExit, compileOut.ToString() + compileErr.ToString(), outPath);
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            if (dir != null)
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
