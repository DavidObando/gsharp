// <copyright file="Issue988TypeParameterConstructionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #988 — constructing a type parameter under a
/// <c>init()</c> default-constructor constraint (<c>T()</c> where <c>[T init()]</c>).
/// <para>
/// G# now accepts a <c>init()</c> constraint on a generic type or function
/// parameter and lets the body construct that parameter with the call-like
/// spelling <c>T()</c>. The construction lowers to a reified
/// <c>System.Activator.CreateInstance&lt;T&gt;()</c> (ADR-0087), which works for
/// both reference types with a public parameterless constructor and value types.
/// These tests lock the feature in at the emit layer: parse + bind + emit +
/// ilverify + execute, plus the two negative diagnostics (GS0152 for a type
/// argument that cannot satisfy <c>init()</c>, GS0389 for constructing a type
/// parameter that lacks the constraint), and a metadata assertion that the
/// emitted GenericParam row carries <c>DefaultConstructorConstraint</c>.
/// </para>
/// </summary>
public class Issue988TypeParameterConstructionEmitTests
{
    [Fact]
    public void GenericClass_ConstructsValueTypeParameter_PrintsDefault()
    {
        // The canonical issue #988 sample: a generic factory whose Make()
        // constructs its `[T init()]` parameter. Closed over int32, the default
        // instance is 0.
        var source = """
            package T
            import System
            class Factory[T init()] {
                func Make() T { return T() }
            }
            let f = Factory[int32]()
            Console.WriteLine(f.Make().ToString())
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericClass_ConstructsReferenceTypeParameter_IsNonNull()
    {
        // A user reference type with the implicit public parameterless ctor is
        // constructed through the factory and its field observed — proving the
        // instance is real (non-null), not `default(T)` (which would be null).
        var source = """
            package T
            import System
            class Node {
                var Value int32 = 42
            }
            class Factory[T init()] {
                func Make() T { return T() }
            }
            let f = Factory[Node]()
            let n = f.Make()
            Console.WriteLine(n.Value.ToString())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericFunction_ConstructsTypeParameter_PrintsField()
    {
        // The `init()` constraint and `T()` construction also work on a generic
        // FUNCTION (not just a generic type).
        var source = """
            package T
            import System
            class Node {
                var Value int32 = 7
            }
            func make[U init()]() U { return U() }
            let m = make[Node]()
            Console.WriteLine(m.Value.ToString())
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void TypeArgumentWithoutParameterlessCtor_ReportsGs0152()
    {
        // A type argument that lacks an accessible parameterless constructor
        // cannot satisfy the `init()` constraint at the instantiation site.
        var source = """
            package T
            class NoCtor(Value int32) { }
            class Factory[T init()] {
                func Make() T { return T() }
            }
            let f = Factory[NoCtor]()
            """;

        var diagnostics = CompileAndExpectFailure(source);
        Assert.Contains("GS0152", diagnostics);
    }

    [Fact]
    public void ConstructingTypeParameterWithoutNewConstraint_ReportsGs0389()
    {
        // Constructing a type parameter that carries no `init()` constraint is a
        // clean compile error pointing at the missing constraint.
        var source = """
            package T
            class Factory[T class] {
                func Make() T { return T() }
            }
            """;

        var diagnostics = CompileAndExpectFailure(source);
        Assert.Contains("GS0389", diagnostics);
    }

    [Fact]
    public void EmittedGenericParam_CarriesDefaultConstructorConstraintFlag()
    {
        // ADR-0087: the emitted GenericParam row must faithfully carry the
        // DefaultConstructorConstraint flag so the metadata round-trips.
        var source = """
            package T
            class Factory[T init()] {
                func Make() T { return T() }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue988_meta_").FullName;
        try
        {
            var outPath = CompileLibrary(source, tempDir);
            var asm = Assembly.LoadFile(outPath);
            var factory = asm.GetTypes().First(t => t.Name.StartsWith("Factory", StringComparison.Ordinal));
            var tp = factory.GetGenericArguments().Single();
            Assert.True(
                tp.GenericParameterAttributes.HasFlag(GenericParameterAttributes.DefaultConstructorConstraint),
                $"Expected DefaultConstructorConstraint on '{tp.Name}', got {tp.GenericParameterAttributes}.");
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue988_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var (compileExit, compileText) = RunCompiler(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileText}");
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
            TryDeleteDirectory(tempDir);
        }
    }

    private static string CompileLibrary(string source, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var (compileExit, compileText) = RunCompiler(new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        });

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileText}");
        return outPath;
    }

    private static string CompileAndExpectFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue988_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var (compileExit, compileText) = RunCompiler(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });

            Assert.True(compileExit != 0, $"expected compile failure but it succeeded: {compileText}");
            return compileText;
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) RunCompiler(string[] args)
    {
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

        return (compileExit, compileOut.ToString() + compileErr.ToString());
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
        }
    }
}
