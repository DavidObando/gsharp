// <copyright file="GenericTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 emit-parity tests for generic user-defined types (Phase 4.3) —
/// emit commit F2: type-erased generic types.
/// <para>
/// Each open type parameter <c>T</c> is encoded as <c>System.Object</c> in
/// the type's field/primary-ctor signatures. Constructed instances
/// (<c>Box[int]</c>) share the definition's CLR TypeDef; value-type
/// substitutions cross the boundary via <c>box</c> at field initializers
/// and primary-ctor arguments, and <c>unbox.any</c> at field loads.
/// </para>
/// </summary>
public class GenericTypeEmitTests
{
    [Fact]
    public void GenericDataStruct_IntField_RoundTrips()
    {
        var source = """
            package P
            import System

            type Box[T any] data struct {
                Value T
            }

            let b = Box[int]{Value: 42}
            Console.WriteLine(b.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void GenericDataStruct_StringField_RoundTrips()
    {
        var source = """
            package P
            import System

            type Box[T any] data struct {
                Value T
            }

            let b = Box[string]{Value: "hi"}
            Console.WriteLine(b.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void GenericClass_PrimaryCtor_IntField_RoundTrips()
    {
        var source = """
            package P
            import System

            type Box[T any] class(Value T) {
            }

            let b = Box[int](7)
            Console.WriteLine(b.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void GenericClass_PrimaryCtor_StringField_RoundTrips()
    {
        var source = """
            package P
            import System

            type Box[T any] class(Value T) {
            }

            let b = Box[string]("hello")
            Console.WriteLine(b.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void GenericDataStruct_TwoParams_MixedValueAndReference()
    {
        var source = """
            package P
            import System

            type Pair[A any, B any] data struct {
                First A
                Second B
            }

            let p = Pair[int, string]{First: 3, Second: "x"}
            Console.WriteLine(p.First)
            Console.WriteLine(p.Second)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\nx\n", output);
    }

    [Fact]
    public void GenericDataStruct_IntField_UsedInArithmetic()
    {
        // Round-trip proof: unbox.any after ldfld must produce a real int
        // so the JIT can fold it into the add.
        var source = """
            package P
            import System

            type Box[T any] data struct {
                Value T
            }

            let b = Box[int]{Value: 20}
            Console.WriteLine(b.Value + 22)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_generic_type_emit_").FullName;
        try
        {
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
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

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
}
