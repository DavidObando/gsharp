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
/// observable behavior as the equivalent positional form. Binding maps values
/// to parameter slots while preserving lexical source evaluation through
/// ordered temporary captures.
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
    public void UserFunction_ReorderedNamedArguments_EvaluateInSourceOrder()
    {
        var source = """
            package P

            public var trace = ""

            func mark(label string, value int32) int32 {
                trace = trace + label
                return value
            }

            func consume(a int32, b int32) {
                trace = trace + "$a$b"
            }

            consume(b: mark("B", 2), a: mark("A", 1))
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var traceField = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal("BA12", (string)traceField!.GetValue(null)!);
    }

    [Fact]
    public void ClrInstance_ReorderedNamedArguments_EvaluateInSourceOrder()
    {
        var source = """
            package P

            public var trace = ""
            public var result = -1

            func markInt(label string, value int32) int32 {
                trace = trace + label
                return value
            }

            func markString(label string, value string) string {
                trace = trace + label
                return value
            }

            result = "hello".IndexOf(
                startIndex: markInt("S", 0),
                value: markString("V", "h"))
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var traceField = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal("SV", (string)traceField!.GetValue(null)!);
        Assert.Equal(0, (int)resultField!.GetValue(null)!);
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
    public void UserClassPrimaryCtor_NamedArguments_EvaluateInSourceOrder()
    {
        var source = """
            package P

            class Point(X int32, Y int32) {
            }

            public var trace = ""
            public var result = 0

            func mark(label string, value int32) int32 {
                trace = trace + label
                return value
            }

            let p = Point(Y: mark("Y", 7), X: mark("X", 3))
            result = p.X * 10 + p.Y
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var traceField = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal("YX", (string)traceField!.GetValue(null)!);
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

    [Fact]
    public void UserExtension_NamedArguments_EvaluateInSourceOrder()
    {
        var source = """
            package P

            class Box {
            }

            public var trace = ""

            func mark(label string, value int32) int32 {
                trace = trace + label
                return value
            }

            func (box Box) Consume(a int32, b int32) {
                trace = trace + "$a$b"
            }

            let box = Box()
            box.Consume(b: mark("B", 2), a: mark("A", 1))
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var traceField = program.GetField("trace", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal("BA12", (string)traceField!.GetValue(null)!);
    }

    [Fact]
    public void UserStaticMethod_NamedArguments_BindAndEvaluate()
    {
        var source = """
            package P

            class Fixture {
                shared {
                    func Describe(name string, count int32, loud bool) string {
                        return "$name:$count:$loud"
                    }
                }
            }

            public var result = Fixture.Describe(
                name: "cat",
                count: 2,
                loud: false)
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal("cat:2:False", (string)resultField!.GetValue(null)!);
    }

    [Fact]
    public void UserStaticVariadic_InPositionNamedThenPositional_BindsAndEvaluates()
    {
        var source = """
            package P

            class Encryptor {
                shared {
                    func Merge(additionalCapacity int32, values ...int32) int32 {
                        return additionalCapacity + values.Length
                    }
                }
            }

            public var result = Encryptor.Merge(
                additionalCapacity: 5,
                10,
                20,
                30)
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(8, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void DelegateAndFunctionValues_NamedArguments_BindAndEvaluate()
    {
        var source = """
            package P

            delegate Operation(x int32, y int32) int32;

            func subtract(x int32, y int32) int32 {
                return x - y
            }

            public var result = 0

            let named Operation = subtract
            let structural (int32, int32) -> int32 =
                func(x int32, y int32) int32 {
                    return x - y
                }

            result = named(y: 3, x: 10) * 10 +
                structural(y: 3, x: 10)
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(77, (int)resultField!.GetValue(null)!);
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
