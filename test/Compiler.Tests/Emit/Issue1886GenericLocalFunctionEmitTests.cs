// <copyright file="Issue1886GenericLocalFunctionEmitTests.cs" company="GSharp">
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
/// Issue #1886: a generic local function (`T First&lt;T&gt;(a, b) { ... }` in C#)
/// could not be represented in G# because function literals had no way to
/// declare type parameters — `let First = func (a T, b T) T { ... }` fails
/// with GS0113 (`T` doesn't exist). These tests exercise the new
/// `let Name[T, ...] = func (...) ... { ... }` generic function-literal
/// syntax end to end: parse, bind, emit, and run, for both single and
/// multi type-parameter shapes, plus the capture-rejection diagnostic
/// (GS0463) for a generic local function that reads an outer variable.
/// </summary>
public class Issue1886GenericLocalFunctionEmitTests
{
    [Fact]
    public void GenericLocalFunction_SingleTypeParameter_CalledWithDifferentTypeArguments()
    {
        var source = """
            package P

            let First[T] = func (a T, b T) T {
                return a
            }
            Console.WriteLine(First(1, 2))
            Console.WriteLine(First("x", "y"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nx\n", output);
    }

    [Fact]
    public void GenericLocalFunction_MultipleTypeParameters_InferredFromArguments()
    {
        var source = """
            package P

            let Combine[T, U] = func (a T, b U) string {
                return a.ToString() + b.ToString()
            }
            Console.WriteLine(Combine(1, "y"))
            Console.WriteLine(Combine(3, 4))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1y\n34\n", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedInsideAnOrdinaryFunction_Works()
    {
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
    public void GenericLocalFunction_NestedInsideAClassSharedMethod_Works()
    {
        // Regression: ClosureEmitter.SynthesizeClosures reroutes every
        // non-capturing lambda lexically declared inside a non-generic user
        // type into a nested (fieldless) display class (issue #1469), but the
        // direct-call emission path for a real FunctionSymbol (which is how a
        // generic local function resolves) never consults that rerouting map
        // — only the delegate-value indirect-call path does. That mismatch
        // threw "Call to function 'First' has no emitted MethodDef." at
        // compile time when a generic local function lived inside a class's
        // `shared` method (surfaced by the cs2gs grid corpus fixtures).
        var source = """
            package P

            class Fixture {
                shared {
                    func Run() {
                        let First[T] = func (a T, b T) T {
                            return a
                        }
                        Console.WriteLine(First(1, 2))
                        Console.WriteLine(First("x", "y"))
                    }
                }
            }
            Fixture.Run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nx\n", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingOuterVariable_ReportsGS0463()
    {
        var source = """
            package P

            func Foo() {
                let outer = 5
                let Bad[T] = func (a T) T {
                    Console.WriteLine(outer)
                    return a
                }
                Console.WriteLine(Bad(1))
            }
            Foo()
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0463", stdout + stderr);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_1886_").FullName;
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
