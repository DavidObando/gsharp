// <copyright file="Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests.cs" company="GSharp">
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
/// Issue #2016: the non-generic sibling of #1940. A NON-generic local function (`let Name = func
/// (...) ... {...}`, no `[T, ...]` of its own) that captures no outer variables is hoisted to a
/// top-level static method (issue #1469's zero-capture fast path) UNLESS it is nested inside a
/// non-generic user type purely for accessibility (<c>ClosureEmitter.SynthesizeClosures</c>). When
/// there is no such non-generic-struct nesting available — because the local function is declared
/// at top level or because its enclosing user type is itself generic — a direct reference to an
/// enclosing type parameter in the local function's OWN parameter type, return type, or body has no
/// corresponding CLR slot on that hoisted method. Before this fix that silently emitted invalid IL
/// that crashed at run time with <see cref="BadImageFormatException"/> and no compile-time
/// diagnostic. These tests assert the (reused) GS0468 diagnostic fires for this non-generic shape,
/// and that legitimate zero-capture / capturing shapes that were never actually broken keep
/// compiling and running correctly (no false positives).
/// </summary>
public class Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests
{
    [Fact]
    public void NonGenericLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U](seed U) U {
                let Local = func (x U) U {
                    return x
                }
                Console.WriteLine(Local(seed))
                return seed
            }
            Outer("hi")
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericLocalFunction_ReturnTypeReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Local = func () U {
                    return default
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericLocalFunction_BodyReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Local = func () {
                    let z U = default
                    Console.WriteLine(z)
                }
                Local()
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericLocalFunction_ReferencesEnclosingGenericClassTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            class Box[U] {
                func Run(seed U) {
                    let Local = func (x U) U {
                        return x
                    }
                    Console.WriteLine(Local(seed))
                }
            }
            let b = Box[string]{}
            b.Run("hi")
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericLocalFunction_NoEnclosingGeneric_CompilesAndRunsWithoutGS0468()
    {
        // No enclosing generic method/class in scope at all — must not false-positive.
        var source = """
            package P

            func Foo() int32 {
                let Local = func (x int32) int32 {
                    return x
                }
                return Local(42)
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NonGenericLocalFunction_CapturesOuterVariableOfEnclosingTypeParameterType_CompilesAndRunsWithoutGS0468()
    {
        // A local function that CAPTURES an outer variable (of the enclosing type
        // parameter's type) routes through the already-reified closure path
        // (issues #1477/#1512), not the zero-capture fast path — must not
        // false-positive.
        var source = """
            package P

            func Outer[U](seed U) U {
                let Echo = func () {
                    var z U = seed
                    Console.WriteLine(z)
                }
                Echo()
                return seed
            }
            Console.WriteLine(Outer("hi"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\nhi\n", output);
    }

    [Fact]
    public void NonGenericLocalFunction_InNonGenericClassMemberReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // The zero-capture local function is nested inside a NON-generic user
        // type (for accessibility, issue #1469); that nested display class is
        // already reified over the enclosing generic method's own type
        // parameter, so this genuinely compiles and runs correctly — must not
        // false-positive.
        var source = """
            package P

            class Box {
                func Run[U](seed U) {
                    let Local = func (x U) U {
                        return x
                    }
                    Console.WriteLine(Local(seed))
                }
            }
            let b = Box{}
            b.Run("hi")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2016_").FullName;
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

            if (!expectSuccess)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
