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

    [Fact]
    public void GenericLocalFunction_IsExpressionTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Inner[T] = func (x object) bool {
                    return x is U
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_TypeOfTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        var source = """
            package P
            import System

            func Outer[U]() {
                let Inner[T] = func () Type {
                    return typeof(U)
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_SizeOfTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            func Outer[U unmanaged](seed U) {
                let Inner[T] = func () int32 {
                    return sizeof(U)
                }
            }
            Outer(42)
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_UserInstanceGenericCallTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        var source = """
            package P

            class Box {
                func Peek[T]() int32 {
                    return 0
                }
            }

            func Outer[U]() {
                let b = Box{}
                let Inner[T] = func () int32 {
                    return b.Peek[U]()
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_ImportedStaticGenericCallTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        var source = """
            package P
            import System.Runtime.CompilerServices

            func Outer[U]() {
                let Inner[T] = func () bool {
                    return RuntimeHelpers.IsReferenceOrContainsReferences[U]()
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NestedGenericLocalFunctions_InnermostReferencesOutermostTypeParameter_ReportsGS0468()
    {
        // Two levels of local-function nesting: Innermost[V] must see the outermost
        // Outer[T]'s T as an enclosing type parameter, skipping over Middle[U]'s scope.
        var source = """
            package P

            func Outer[T]() {
                let Middle[U] = func () {
                    let Innermost[V] = func (x V) T {
                        return default
                    }
                }
            }
            Outer[string]()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericLocalFunction_ReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // N2: a NON-generic local function (no [T] of its own) referencing the
        // enclosing method's type parameter is legal — it is hoisted with the
        // enclosing generic's own MVAR slots reachable, not a fresh method with
        // an unrelated type-parameter list. Must not false-positive.
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
    public void GenericLocalFunction_ShadowingSameNameAsEnclosingTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // N3: `Inner[T]` nested in `Outer[T]` — the inner `T` SHADOWS the outer
        // `T` (a distinct symbol with the same name). Referencing `T` inside
        // `Inner` resolves to the inner function's own type parameter, not the
        // enclosing one, and must not false-positive.
        var source = """
            package P

            func Outer[T](seed T) T {
                let Inner[T] = func (x T) T {
                    return x
                }
                return Inner(seed)
            }
            Console.WriteLine(Outer(7))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void GenericLocalFunction_ConstrainedStaticVoidCallTargetsEnclosingTypeParameter_ReportsGS0468()
    {
        // NB1 (review #2013): a static-virtual interface call `U.M(...)` with a
        // VOID return has node.Type == void, so the enclosing type parameter `U`
        // in the constrained receiver is only reachable via the call node's own
        // TypeParameter field — otherwise silent invalid IL.
        var source = """
            package P

            import System

            sealed interface ISink {
                shared {
                    func Consume(x int32);
                }
            }

            class Printer : ISink {
                shared {
                    func Consume(x int32) {
                    }
                }
            }

            func Outer[U ISink](w U) {
                let Inner[V] = func () {
                    U.Consume(1)
                }
            }
            Outer(Printer{})
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
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
