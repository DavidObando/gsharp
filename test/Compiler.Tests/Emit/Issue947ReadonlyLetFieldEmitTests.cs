// <copyright file="Issue947ReadonlyLetFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #947 regression tests for read-only (<c>let</c>) fields gaining C#
/// <c>readonly</c>-field semantics: a <c>let</c> field is assignable exactly
/// during construction — by its declaration initializer and/or inside the
/// declaring type's constructor (<c>init(...)</c>) — and immutable everywhere
/// else. The cases exercised end-to-end are:
/// <list type="bullet">
///   <item>a <c>let</c> field with no initializer assigned inside the
///   constructor and read back at runtime (bare <c>x = v</c> form);</item>
///   <item>the same through the qualified <c>this.x = v</c> form;</item>
///   <item>a <c>let</c> field with an initializer that is overwritten in the
///   constructor (multiple ctor writes are allowed, like C#);</item>
///   <item>assigning a <c>let</c> field from a non-constructor method is a
///   compile error (<c>GS0127</c>);</item>
///   <item>assigning a <c>let</c> field on a different instance is a compile
///   error (<c>GS0127</c>);</item>
///   <item>the emitted field carries the CLR <c>initonly</c> flag — the
///   metadata encoding of a C# <c>readonly</c> field.</item>
/// </list>
/// The run tests compile a hermetic program with <c>gsc</c> in-process, IL
/// verify the produced assembly, and execute it with <c>dotnet exec</c>.
/// </summary>
public class Issue947ReadonlyLetFieldEmitTests
{
    [Fact]
    public void LetField_AssignedInConstructor_NoInitializer_RoundTrips()
    {
        var source = """
            package P
            import System

            class Point {
                let x int32
                let y int32
                init(a int32, b int32) {
                    x = a
                    y = b
                }
                func Sum() int32 {
                    return x + y
                }
            }

            let p = Point(3, 4)
            Console.WriteLine(p.Sum())
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void LetField_AssignedViaThisInConstructor_RoundTrips()
    {
        var source = """
            package P
            import System

            class Person {
                let name string
                let age int32
                init(n string) {
                    this.name = n
                    this.age = 30
                }
            }

            let a = Person("ctor")
            Console.WriteLine(a.name)
            Console.WriteLine(a.age)
            """;

        Assert.Equal("ctor\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void LetField_WithInitializer_OverwrittenInConstructor_RoundTrips()
    {
        // C# permits any number of writes to a readonly field within the
        // constructor; the declaration initializer plus a ctor overwrite is
        // allowed and the last write wins.
        var source = """
            package P
            import System

            class Config {
                let value int32 = 10
                init(v int32) {
                    value = v
                }
                func Get() int32 {
                    return value
                }
            }

            let c = Config(42)
            Console.WriteLine(c.Get())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void AssigningLetField_FromNormalMethod_IsCompileError()
    {
        // Negative test: writing a `let` field outside the constructor remains
        // a GS0127 ("read-only") error.
        var source = """
            package P

            class C {
                let x int32
                init() {
                    x = 1
                }
                func Bad() {
                    x = 2
                }
            }
            """;

        var diagnostics = Emit(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void AssigningLetField_OnAnotherInstance_IsCompileError()
    {
        // Negative test: writing a `let` field on a *different* instance (not
        // `this`) is rejected even though the assignment textually appears in a
        // method of the declaring type.
        var source = """
            package P

            class C {
                let x int32
                init(v int32) {
                    x = v
                }
                func Copy(other C) {
                    other.x = 99
                }
            }
            """;

        var diagnostics = Emit(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void EmittedLetField_IsInitOnly()
    {
        var source = """
            package P
            import System

            class Point {
                let x int32
                var y int32
                init(a int32, b int32) {
                    x = a
                    y = b
                }
            }

            let p = Point(1, 2)
            Console.WriteLine(p.x)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue947_initonly_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var (exit, output) = Compile(source, outPath, tempDir);
            Assert.True(exit == 0, $"gsc failed: {output}");

            var alc = new AssemblyLoadContext("issue947-initonly", isCollectible: true);
            try
            {
                var asm = alc.LoadFromAssemblyPath(outPath);
                var pointType = asm.GetTypes().FirstOrDefault(t => t.Name == "Point")
                    ?? throw new InvalidOperationException("Point type not found");

                var letField = pointType.GetField("x", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    ?? throw new InvalidOperationException("field 'x' not found");
                Assert.True(letField.IsInitOnly, "the `let` field must be emitted as initonly");

                var varField = pointType.GetField("y", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    ?? throw new InvalidOperationException("field 'y' not found");
                Assert.False(varField.IsInitOnly, "the `var` field must not be initonly");
            }
            finally
            {
                alc.Unload();
            }
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static IReadOnlyList<Diagnostic> Emit(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "issue947.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);
        return result.Diagnostics;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue947_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var (exit, output) = Compile(source, outPath, tempDir);
            Assert.True(exit == 0, $"gsc failed: {output}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) Compile(string source, string outPath, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
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

        return (compileExit, $"stdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // Best-effort cleanup; the OS reclaims scratch directories later.
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
