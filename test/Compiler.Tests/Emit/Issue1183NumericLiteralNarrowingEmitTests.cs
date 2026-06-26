// <copyright file="Issue1183NumericLiteralNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1183: emit/runtime coverage for C#-compatible numeric literal
/// narrowing/widening. Verifies the produced IL is verifiable and that the
/// runtime values match C# semantics: widened values are preserved, in-range
/// constants narrow to a correctly-typed constant, and an explicit
/// float→int narrowing truncates (e.g. (int)19.75 == 19).
/// </summary>
public class Issue1183NumericLiteralNarrowingEmitTests
{
    [Fact]
    public void ImplicitWidening_Int32ToInt64_PreservesValue()
    {
        var source = """
            package P

            func Widen() int64 {
                var itemCount int32 = 42
                var widened int64 = itemCount
                return widened
            }
            """;

        var widen = GetMethod(CompileToAssembly(source), "Widen");
        Assert.Equal(42L, widen.Invoke(null, null));
    }

    [Fact]
    public void ExplicitNarrowing_Float64ToInt32_Truncates()
    {
        var source = """
            package P

            func Truncate() int32 {
                var average float64 = 19.75
                var truncated int32 = int32(average)
                return truncated
            }
            """;

        var truncate = GetMethod(CompileToAssembly(source), "Truncate");
        Assert.Equal(19, truncate.Invoke(null, null));
    }

    [Fact]
    public void InRangeConstantNarrowing_ProducesCorrectlyTypedConstant()
    {
        var source = """
            package P

            func NarrowByte() uint8 {
                var a uint8 = 200
                return a
            }

            func NarrowShort() int16 {
                var s int16 = -30000
                return s
            }

            func NarrowUInt() uint32 {
                var u uint32 = 5
                return u
            }
            """;

        var assembly = CompileToAssembly(source);

        var narrowByte = GetMethod(assembly, "NarrowByte");
        Assert.Equal((byte)200, narrowByte.Invoke(null, null));
        Assert.Equal(typeof(byte), narrowByte.ReturnType);

        var narrowShort = GetMethod(assembly, "NarrowShort");
        Assert.Equal((short)-30000, narrowShort.Invoke(null, null));
        Assert.Equal(typeof(short), narrowShort.ReturnType);

        var narrowUInt = GetMethod(assembly, "NarrowUInt");
        Assert.Equal((uint)5, narrowUInt.Invoke(null, null));
        Assert.Equal(typeof(uint), narrowUInt.ReturnType);
    }

    [Fact]
    public void NegativeInRangeConstant_NarrowsToSigned()
    {
        var source = """
            package P

            func NegByte() int8 {
                var b int8 = -5
                return b
            }
            """;

        var negByte = GetMethod(CompileToAssembly(source), "NegByte");
        Assert.Equal((sbyte)-5, negByte.Invoke(null, null));
        Assert.Equal(typeof(sbyte), negByte.ReturnType);
    }

    private static MethodInfo GetMethod(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var method = program.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1183_emit_").FullName;
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
                "/target:library",
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
