// <copyright file="Issue640FieldInitializerEmitTests.cs" company="GSharp">
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
/// Issue #640: class field initializers (<c>field T = expr</c>) must be
/// evaluated at construction time and emitted into every constructor body.
/// Each test compiles via <c>gsc</c>, ilverifies the produced PE, then
/// executes the assembly under <c>dotnet exec</c> and asserts on the
/// captured stdout.
/// </summary>
public class Issue640FieldInitializerEmitTests
{
    [Fact]
    public void Int32_Field_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var n int32 = 42
                func Get() int32 { return n }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Int64_Field_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var n int64 = 100
                func Get() int64 { return n }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    [Fact]
    public void Bool_Field_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var flag bool = true
                func Get() bool { return flag }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void String_Field_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var s string = "hello"
                func Get() string { return s }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void Computed_Expression_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var c int32 = 1 + 2 * 3
                func Get() int32 { return c }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Multiple_Fields_With_Initializers()
    {
        var source = """
            package P
            import System

            type Multi class {
                var a int32 = 10
                var b int32 = 20
                var c string = "abc"
                func Show() string {
                    return a.ToString() + "," + b.ToString() + "," + c
                }
            }

            var m = Multi()
            Console.WriteLine(m.Show())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10,20,abc\n", output);
    }

    [Fact]
    public void Initializer_Runs_With_ExplicitInit_Constructor()
    {
        // Field initializers run BEFORE the user-authored init body.
        var source = """
            package P
            import System

            type Widget class {
                var baseValue int32 = 100
                var extra int32

                init(e int32) {
                    extra = e
                }

                func Total() int32 { return baseValue + extra }
            }

            var w = Widget(5)
            Console.WriteLine(w.Total())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("105\n", output);
    }

    [Fact]
    public void Initializer_Runs_With_PrimaryConstructor()
    {
        var source = """
            package P
            import System

            type Thing class(name string) {
                var prefix string = "Item:"
                func Label() string { return prefix + name }
            }

            var t = Thing("foo")
            Console.WriteLine(t.Label())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Item:foo\n", output);
    }

    [Fact]
    public void Initializer_Runs_For_All_Constructor_Overloads()
    {
        // Use a single init(x int32) to confirm field initializer still runs.
        var source = """
            package P
            import System

            type Dual class {
                var tag string = "default"
                var n int32

                init(x int32) {
                    n = x
                }

                func Show() string { return tag + ":" + n.ToString() }
            }

            var b = Dual(7)
            Console.WriteLine(b.Show())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("default:7\n", output);
    }

    [Fact]
    public void Inheritance_DerivedFieldInitializers_Run()
    {
        var source = """
            package P
            import System

            type Base open class {
                var baseVal int32 = 1
                func GetBase() int32 { return baseVal }
            }

            type Derived class : Base {
                var derivedVal int32 = 2
                func GetDerived() int32 { return derivedVal }
            }

            var d = Derived()
            Console.WriteLine(d.GetBase())
            Console.WriteLine(d.GetDerived())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void Field_Without_Initializer_StillDefaultsToZero()
    {
        // Regression guard: fields without initializers must still default.
        var source = """
            package P
            import System

            type Mixed class {
                var initialized int32 = 42
                var uninitialized int32
                func Show() string {
                    return initialized.ToString() + "," + uninitialized.ToString()
                }
            }

            var m = Mixed()
            Console.WriteLine(m.Show())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42,0\n", output);
    }

    [Fact]
    public void Double_Field_Initializer()
    {
        var source = """
            package P
            import System

            type Holder class {
                var d float64 = 3.14
                func Get() float64 { return d }
            }

            var h = Holder()
            Console.WriteLine(h.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3.14\n", output);
    }

    [Fact]
    public void ExplicitInit_CanOverrideFieldInitializer()
    {
        // The user-defined init body runs AFTER field initializers,
        // so it can override the field's initial value.
        var source = """
            package P
            import System

            type Override class {
                var n int32 = 10

                init(value int32) {
                    n = value
                }

                func Get() int32 { return n }
            }

            var o = Override(99)
            Console.WriteLine(o.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    // Test infrastructure — mirrors Issue524DefaultCtorEmitTests pattern.

    private static string CompileAndRun(string source)
    {
        var (exit, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exit == 0,
            $"exited {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue640_").FullName;
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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
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
