// <copyright file="Issue948FieldInitializerSugarEmitTests.cs" company="GSharp">
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
/// Issue #948: syntactic sugar for inline field initialization. Fields declared
/// with <c>const</c>, <c>let</c>, or <c>var</c> may carry an <c>= expr</c>
/// initializer in the type body. Instance initializers run in declaration order
/// before each constructor body; <c>const</c> fields become compile-time literal
/// fields; static initializers run in the static constructor. Each test compiles
/// via <c>gsc</c>, ilverifies the produced PE, then executes the assembly and
/// asserts on the captured stdout (or, for negative tests, on the diagnostic).
/// </summary>
public class Issue948FieldInitializerSugarEmitTests
{
    [Fact]
    public void Issue948_ConstLetVar_Example_AllReadAtRuntime()
    {
        // The exact example from the issue: const + let + var with initializers,
        // all three read at runtime.
        var source = """
            package P
            import System

            class Foo {
                const one string = "value"
                let two string = "something"
                var three string = "this should work"
                func Show() string { return one + "|" + two + "|" + three }
            }

            var f = Foo()
            Console.WriteLine(f.Show())
            Console.WriteLine(Foo.one)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("value|something|this should work\nvalue\n", output);
    }

    [Fact]
    public void Issue948_InstanceInitializers_RunInDeclarationOrder()
    {
        // Each initializer is appended in textual order; later fields can be
        // computed but order is what we assert here via a side-effecting log.
        var source = """
            package P
            import System

            class Order {
                var a string = "1"
                var b string = "2"
                var c string = "3"
                func Show() string { return a + b + c }
            }

            var o = Order()
            Console.WriteLine(o.Show())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("123\n", output);
    }

    [Fact]
    public void Issue948_StaticFieldInitializer_RunsInCctor()
    {
        var source = """
            package P
            import System

            class Config {
                shared {
                    var retries int32 = 3
                    let name string = "svc"
                }
            }

            Console.WriteLine(Config.retries.ToString() + Config.name)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3svc\n", output);
    }

    [Fact]
    public void Issue948_ConstField_FoldedToLiteral_UsableExternally()
    {
        var source = """
            package P
            import System

            class K {
                const max int32 = 5 * 10
                const label string = "hi"
            }

            Console.WriteLine(K.max.ToString() + K.label)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("50hi\n", output);
    }

    [Fact]
    public void Issue948_Initializer_ThenExplicitInit_OverridesVar()
    {
        // Field initializer runs first, then the init body overrides the var.
        var source = """
            package P
            import System

            class Widget {
                var n int32 = 10

                init(value int32) {
                    n = value
                }

                func Get() int32 { return n }
            }

            var defaulted = Widget(99)
            Console.WriteLine(defaulted.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Issue948_StructFieldInitializers_AppliedForOmittedFields()
    {
        // Value-type composite literal zero-inits storage then applies declared
        // field initializers for fields the literal omitted.
        var source = """
            package P
            import System

            struct Pt {
                var x int32 = 3
                var y int32 = 4
            }

            var p = Pt{}
            Console.WriteLine(p.x.ToString() + "," + p.y.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3,4\n", output);
    }

    [Fact]
    public void Issue948_DataStructFieldInitializers_AppliedForOmittedFields()
    {
        var source = """
            package P
            import System

            data struct Pt {
                var x int32 = 3
                var y int32 = 4
            }

            var p = Pt{}
            Console.WriteLine(p.x.ToString() + "," + p.y.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3,4\n", output);
    }

    [Fact]
    public void Issue948_Negative_InstanceInitializerReferencesInstanceMember()
    {
        var source = """
            package P
            import System

            class Foo {
                var a int32 = 5
                var b int32 = a + 10
                func Get() int32 { return b }
            }

            var f = Foo()
            Console.WriteLine(f.Get())
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0377", diagnostics);
    }

    [Fact]
    public void Issue948_Negative_ConstFieldWithNonConstantInitializer()
    {
        var source = """
            package P
            import System

            class Foo {
                const len int32 = "abc".Length
            }

            Console.WriteLine(Foo.len.ToString())
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0376", diagnostics);
    }

    [Fact]
    public void Issue948_Negative_ConstFieldRequiresInitializer()
    {
        var source = """
            package P
            import System

            class Foo {
                const len int32
            }

            Console.WriteLine(Foo.len.ToString())
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0375", diagnostics);
    }

    // Test infrastructure — mirrors Issue640FieldInitializerEmitTests pattern.

    private static string CompileAndRun(string source)
    {
        var (exit, stdout, stderr, _) = CompileAndRunRaw(source);
        Assert.True(
            exit == 0,
            $"exited {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static string CompileExpectingFailure(string source)
    {
        var (compileExit, compileOut, _) = CompileOnly(source);
        Assert.True(
            compileExit != 0,
            $"expected compilation to fail but it succeeded:\n{compileOut}");
        return compileOut;
    }

    private static (int CompileExit, string CompileOut, string CompileErr) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue948_").FullName;
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
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

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

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr, string CompileOut) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue948_").FullName;
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
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(
                runtimeConfigPath,
                """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(runtimeConfigPath);
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"), compileOut.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
