// <copyright file="NamedArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #343 emit tests. Compiles GSharp programs that use named arguments
/// at call sites and verifies the resulting PE executes with the same
/// observable behavior as the equivalent positional form. The bound call
/// reorders arguments into parameter order before lowering, so the emitted
/// IL must push values onto the stack in parameter (not source) order.
/// </summary>
public class NamedArgumentEmitTests
{
    [Fact]
    public void UserFunction_NamedArguments_ReorderToParameterOrder_AtEntryPoint()
    {
        // sub(10, 3) - sub(y: 3, x: 10) - sub(10, y: 3) all yield 7.
        var source = """
            package P
            import System

            public var result = 0

            func sub(x int32, y int32) int32 {
                return x - y
            }

            let a = sub(10, 3)
            let b = sub(y: 3, x: 10)
            let c = sub(10, y: 3)
            result = a * 100 + b * 10 + c
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(entry);
        Assert.NotNull(resultField);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(777, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void UserClassPrimaryCtor_NamedArguments_ReorderFields()
    {
        var source = """
            package P
            import System

            class Point(X int32, Y int32) {
            }

            public var result = 0

            let p = Point(Y: 7, X: 3)
            result = p.X * 10 + p.Y
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(entry);
        Assert.NotNull(resultField);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(37, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void ClrInstance_StringIndexOf_NamedArguments_ReorderedCorrectly()
    {
        var source = """
            package P
            import System

            public var result = 0

            let s = "hello world"
            result = s.IndexOf(value: "world", startIndex: 0)
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(entry);
        Assert.NotNull(resultField);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(6, (int)resultField!.GetValue(null)!);
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_named_arg_emit_").FullName;
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
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
