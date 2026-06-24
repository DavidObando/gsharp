// <copyright file="Issue1069NestedTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1069: nested <c>struct</c>, <c>data struct</c>, and <c>enum</c>
/// declarations inside a class must emit as real CLR nested types, be
/// constructible and usable from the enclosing type's members and from outside
/// by qualified name, pass ilverify, and execute with the expected runtime
/// values. Nested <c>class</c> already worked and is covered for regression.
/// </summary>
public class Issue1069NestedTypesEmitTests
{
    [Fact]
    public void NestedDataStruct_ConstructedAndUsed_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            open class Outer {
                func Make() uint32 {
                    let e = Entry(7u)
                    return e.X
                }

                data struct Entry(X uint32) { }
            }

            let o = Outer()
            Console.WriteLine(int32(o.Make()))
            """);

        Assert.Equal("7\n", output);
    }

    [Fact]
    public void NestedEnum_AccessedAndUsed_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            open class Outer {
                func Make() Color {
                    return Color.Green
                }

                enum Color { Red, Green }
            }

            let o = Outer()
            Console.WriteLine(int32(o.Make()))
            """);

        Assert.Equal("1\n", output);
    }

    [Fact]
    public void NestedPlainStruct_MembersAccessed_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            open class Outer {
                func Make() int32 {
                    let e = Entry{X: 9}
                    return e.X
                }

                struct Entry { var X int32 }
            }

            let o = Outer()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("9\n", output);
    }

    [Fact]
    public void NestedClass_ConstructedFromEnclosingMethod_Runs_Regression()
    {
        var output = CompileAndRun("""
            package P

            import System

            open class Outer {
                func Make() int32 {
                    let i = Inner() { X = 5 }
                    return i.X
                }

                class Inner { prop X int32 { get; init; } }
            }

            let o = Outer()
            Console.WriteLine(o.Make())
            """);

        Assert.Equal("5\n", output);
    }

    [Fact]
    public void NestedTypes_AccessedByQualifiedNameFromOutside_Runs()
    {
        var output = CompileAndRun("""
            package P

            import System

            open class Outer {
                data struct Entry(X uint32) { }
                enum Color { Red, Green }
                struct Point { var X int32 }
            }

            let e = Outer.Entry(4u)
            Console.WriteLine(int32(e.X))
            let c = Outer.Color.Green
            Console.WriteLine(int32(c))
            let p = Outer.Point{X: 11}
            Console.WriteLine(p.X)
            """);

        Assert.Equal("4\n1\n11\n", output);
    }

    [Fact]
    public void NestedDataStructAndEnum_EmitAsClrNestedTypes()
    {
        var assembly = CompileToLibrary("""
            package P

            open class Outer {
                data struct Entry(X uint32) { }
                enum Color { Red, Green }
                struct Point { var X int32 }
            }
            """);

        var outer = Enumerable.Single(assembly.GetTypes(), t => t.Name == "Outer");

        foreach (var nestedName in new[] { "Entry", "Color", "Point" })
        {
            var nested = outer.GetNestedType(nestedName, BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(nested);
            Assert.True(nested!.IsNested, $"{nestedName} should be a CLR nested type");
            Assert.Equal(outer, nested.DeclaringType);
        }

        var color = outer.GetNestedType("Color", BindingFlags.Public | BindingFlags.NonPublic);
        Assert.True(color!.IsEnum);

        var entry = outer.GetNestedType("Entry", BindingFlags.Public | BindingFlags.NonPublic);
        Assert.True(entry!.IsValueType);

        var point = outer.GetNestedType("Point", BindingFlags.Public | BindingFlags.NonPublic);
        Assert.True(point!.IsValueType);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1069_emit_").FullName;
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

    private static Assembly CompileToLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1069_lib_").FullName;
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
        return Assembly.Load(File.ReadAllBytes(outPath));
    }
}
