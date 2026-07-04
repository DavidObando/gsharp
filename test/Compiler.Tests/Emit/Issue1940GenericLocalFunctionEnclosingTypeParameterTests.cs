// <copyright file="Issue1940GenericLocalFunctionEnclosingTypeParameterTests.cs" company="GSharp">
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
/// Issue #1940: a generic local function (<c>let Inner[T] = func (...) ... { ... }</c>, issue #1886) is
/// hoisted to its own top-level static method carrying only ITS OWN type-parameter list as CLR MVAR
/// slots. Referencing a type parameter owned by an enclosing generic method or class — in the local
/// function's parameter types, return type, or body — has no corresponding slot on that hoisted method.
/// Before this fix that silently emitted invalid IL that crashed at run time with
/// <see cref="InvalidProgramException"/> and no compile-time diagnostic. These tests assert the new
/// GS0468 diagnostic fires for every such reference shape and does NOT false-positive on a generic local
/// function that only uses its own type parameters.
/// </summary>
public class Issue1940GenericLocalFunctionEnclosingTypeParameterTests
{
    [Fact]
    public void GenericLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Inner[T] = func (x T, y U) T {
                    return x
                }
                Console.WriteLine(Inner(1, "hi"))
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_ReturnTypeReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Inner[T] = func (x T) U {
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
    public void GenericLocalFunction_BodyReferencesEnclosingMethodTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Inner[T] = func (x T) T {
                    let z U = default
                    return x
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_ReferencesEnclosingClassTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            class Box[U] {
                func Run() {
                    let Inner[T] = func (x T, y U) T {
                        return x
                    }
                }
            }
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_UsesOnlyItsOwnTypeParameters_CompilesAndRunsWithoutGS0468()
    {
        // No enclosing generic method/class in scope — must not false-positive.
        var source = """
            package P

            func Foo() int32 {
                let Identity[T] = func (a T) T {
                    return a
                }
                return Identity(42)
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedInGenericOuterFunctionButUsingOnlyOwnTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // The enclosing function IS generic, but the local function's signature and body reference
        // only its own type parameter T, never the enclosing U — must not false-positive.
        var source = """
            package P

            func Outer[U](seed U) U {
                let Identity[T] = func (a T) T {
                    return a
                }
                Console.WriteLine(Identity(42))
                return seed
            }
            Console.WriteLine(Outer("done"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\ndone\n", output);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1940_").FullName;
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
