// <copyright file="Issue1182ValueTypeDefaultOptionalParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1182 — emit + IL-verify coverage for a value-type <c>default(T)</c>
/// (and the zero-value <c>T()</c> form) used as an optional-parameter default.
/// When the argument is omitted at a call site, the emitter must materialize
/// the type's all-zero value (verifiable IL), matching C#.
///
/// Covers a BCL value type (<c>TimeSpan</c>), a primitive (<c>int32</c>), and a
/// user <c>data struct</c>, plus a regression guard that an explicitly-supplied
/// argument still overrides the default.
/// </summary>
public class Issue1182ValueTypeDefaultOptionalParameterEmitTests
{
    [Fact]
    public void Primitive_DefaultOf_Omitted_MaterializesZero()
    {
        var source = """
            package Probe

            func F(x int32 = default(int32)) int32 {
                return x
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void Primitive_DefaultOf_Supplied_OverridesDefault()
    {
        var source = """
            package Probe

            func F(x int32 = default(int32)) int32 {
                return x
            }

            public var result = F(42)
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(42, GetField<int>(assembly, "result"));
    }

    [Fact]
    public void BclValueType_DefaultOf_Omitted_MaterializesAllZero()
    {
        var source = """
            package Probe
            import System

            func F(t TimeSpan = default(TimeSpan)) int64 {
                return t.Ticks
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0L, GetField<long>(assembly, "result"));
    }

    [Fact]
    public void BclValueType_ZeroValueConstructorForm_Omitted_MaterializesAllZero()
    {
        var source = """
            package Probe
            import System

            class C {
                var T TimeSpan
                init(t TimeSpan = TimeSpan()) { T = t }
            }

            public var result = C().T.Ticks
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0L, GetField<long>(assembly, "result"));
    }

    [Fact]
    public void UserStruct_DefaultOf_Omitted_MaterializesAllZero()
    {
        var source = """
            package Probe

            data struct Point {
                var X int32
                var Y int32
            }

            func F(p Point = default(Point)) int32 {
                return p.X + p.Y
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(0, GetField<int>(assembly, "result"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1182_").FullName;
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static T GetField<T>(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var resultField = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (T)resultField!.GetValue(null)!;
    }
}
