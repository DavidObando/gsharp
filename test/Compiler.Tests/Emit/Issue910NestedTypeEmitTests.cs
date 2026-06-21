// <copyright file="Issue910NestedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #910 / ADR-0110: nested type declarations (<c>class</c> / <c>struct</c>
/// / <c>interface</c> / <c>enum</c>) inside a <c>class</c> or <c>struct</c> body
/// must be emitted as real CLR nested types with nested accessibility, be
/// usable from the enclosing type's members, pass ilverify, and execute.
/// </summary>
public class Issue910NestedTypeEmitTests
{
    [Fact]
    public void IssueExample_NestedClassInClass_ConstructedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package Oahu.Cli.Tests

            import System

            class Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }

                func Make() string {
                    let i = Inner()
                    return i.Hello()
                }
            }

            let o = Outer()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void NestedStructInStruct_ConstructedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            struct Outer {
                struct Inner {
                    var X int32
                }
            }

            func (o Outer) Make() int32 {
                let i = Inner{X: 41}
                return i.X + 1
            }

            let o = Outer{}
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NestedStructInClass_ConstructedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            class Outer {
                struct Point {
                    var X int32
                    var Y int32
                }

                func Sum() int32 {
                    let p = Point{X: 3, Y: 4}
                    return p.X + p.Y
                }
            }

            let o = Outer()
            Console.WriteLine(o.Sum())
            """);

        Assert.Equal("7\n", output);
    }

    [Fact]
    public void NestedClassInStruct_ReportsDedicatedDiagnostic_NotCascade()
    {
        // ADR-0110: a nested class inside a struct is deferred (ECMA-335
        // §II.22.32 ordering). The compiler must surface the single dedicated
        // GS0369 diagnostic instead of the old misleading parse-error cascade.
        var diagnostics = CompileExpectingFailure("""
            package P

            import System

            struct Outer {
                class Inner {
                    func Hello() string {
                        return "from-nested-class"
                    }
                }
            }

            let o = Outer{}
            Console.WriteLine("unused")
            """);

        Assert.Contains("GS0369", diagnostics);
        Assert.DoesNotContain("GS0288", diagnostics);
        Assert.DoesNotContain("GS0005", diagnostics);
    }

    [Fact]
    public void NestedEnumInClass_UsedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            class Outer {
                enum Color {
                    Red,
                    Green,
                    Blue,
                }

                func Pick() int32 {
                    let c = Color.Green
                    if c == Color.Green {
                        return 1
                    }
                    return 0
                }
            }

            let o = Outer()
            Console.WriteLine(o.Pick())
            """);

        Assert.Equal("1\n", output);
    }

    [Fact]
    public void NestedEnumInStruct_UsedFromEnclosingMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            struct Outer {
                enum Color {
                    Red,
                    Green,
                    Blue,
                }
            }

            func (o Outer) Pick() int32 {
                let c = Color.Blue
                if c == Color.Blue {
                    return 2
                }
                return 0
            }

            let o = Outer{}
            Console.WriteLine(o.Pick())
            """);

        Assert.Equal("2\n", output);
    }

    [Fact]
    public void NestedInterfaceInClass_ReportsDedicatedDiagnostic_NotCascade()
    {
        // ADR-0110: a nested interface is deferred (ECMA-335 §II.22.32
        // ordering). A single dedicated GS0369 diagnostic replaces the old
        // misleading parse-error cascade.
        var diagnostics = CompileExpectingFailure("""
            package P

            import System

            class Outer {
                interface IInner {
                    func Hello() string;
                }
            }

            Console.WriteLine("unused")
            """);

        Assert.Contains("GS0369", diagnostics);
        Assert.DoesNotContain("GS0288", diagnostics);
        Assert.DoesNotContain("GS0005", diagnostics);
    }

    [Fact]
    public void IssueExample_EmitsRealNestedClrType()
    {
        // ADR-0110: the supported combinations are emitted as real CLR nested
        // TypeDefs. Verify via reflection that Inner is nested inside Outer.
        var assembly = CompileToLibrary("""
            package Oahu.Cli.Tests

            class Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }

                func Make() string {
                    let i = Inner()
                    return i.Hello()
                }
            }
            """);

        var outer = System.Linq.Enumerable.Single(assembly.GetTypes(), t => t.Name == "Outer");
        var inner = outer.GetNestedType("Inner", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(inner);
        Assert.True(inner!.IsNested);
        Assert.Equal(outer, inner.DeclaringType);
    }

    [Fact]
    public void RecursivelyNestedClass_ConstructedFromInnermostMethod_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            class Outer {
                class Middle {
                    class Inner {
                        func N() int32 {
                            return 7
                        }
                    }

                    func Make() int32 {
                        let i = Inner()
                        return i.N()
                    }
                }

                func Make() int32 {
                    let m = Middle()
                    return m.Make()
                }
            }

            let o = Outer()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue910_emit_").FullName;
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

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue910_emit_err_").FullName;
        try
        {
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

            Assert.True(compileExit != 0, $"expected compile to fail but it succeeded:\nstdout:\n{compileOut}");
            return compileOut.ToString() + compileErr.ToString();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static System.Reflection.Assembly CompileToLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue910_lib_").FullName;
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

        Assert.True(compileExit == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath);
        return System.Reflection.Assembly.Load(File.ReadAllBytes(outPath));
    }
}
