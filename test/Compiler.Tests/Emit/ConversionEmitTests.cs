// <copyright file="ConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #421 P2-5 emit tests for <c>EmitConversion</c> gaps:
/// interface-to-value-type unbox, enum ⇄ numeric primitive, and the
/// checked-overflow plumbing surfaced through <c>BoundConversionExpression.IsChecked</c>.
/// </summary>
public class ConversionEmitTests
{
    [Fact]
    public void Interface_To_Struct_Cast_Emits_UnboxAny_And_Returns_Original_Value()
    {
        // P2-5 item #1: an interface-typed reference holding a boxed int
        // must `unbox.any` back to the underlying primitive. Previously
        // `EmitConversion` only matched `from?.ClrType == typeof(object)`,
        // so an interface source (here `System.IComparable`, which `int32`
        // implements via implicit boxing) fell through and the emitter
        // threw `NotSupportedException`.
        var source = """
            package P
            import System

            func Roundtrip(value int32) int32 {
                var comparable IComparable = value
                return int32(comparable)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var roundtrip = program.GetMethod(
            "Roundtrip",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(roundtrip);

        var result = roundtrip!.Invoke(null, new object[] { 42 });
        Assert.Equal(42, result);
    }

    [Fact]
    public void Enum_To_Int32_Cast_Returns_Underlying_Value()
    {
        // P2-5 item #2: `int32(enumValue)` must surface the enum's
        // underlying integer. CLR enums share storage with their
        // underlying primitive, so the IL is a no-op once the binder
        // permits the cast.
        var source = """
            package P
            import System

            type Color enum { Red, Green, Blue }

            func ToInt(c Color) int32 {
                return int32(c)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var color = assembly.GetTypes().Single(t => t.Name == "Color");
        var toInt = program.GetMethod(
            "ToInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toInt);

        var red = Enum.ToObject(color, 0);
        var green = Enum.ToObject(color, 1);
        var blue = Enum.ToObject(color, 2);

        Assert.Equal(0, toInt!.Invoke(null, new[] { red }));
        Assert.Equal(1, toInt.Invoke(null, new[] { green }));
        Assert.Equal(2, toInt.Invoke(null, new[] { blue }));
    }

    [Fact]
    public void Int32_To_Enum_Cast_Produces_Corresponding_Enum_Value()
    {
        // P2-5 item #2 (reverse direction): `Color(intValue)` must yield
        // the enum member sharing the integer's underlying value.
        var source = """
            package P
            import System

            type Color enum { Red, Green, Blue }

            func FromInt(i int32) Color {
                return Color(i)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var color = assembly.GetTypes().Single(t => t.Name == "Color");
        var fromInt = program.GetMethod(
            "FromInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(fromInt);

        var result0 = fromInt!.Invoke(null, new object[] { 0 });
        var result1 = fromInt.Invoke(null, new object[] { 1 });
        var result2 = fromInt.Invoke(null, new object[] { 2 });

        Assert.Equal(color, result0.GetType());
        Assert.Equal(0, Convert.ToInt32(result0));
        Assert.Equal(1, Convert.ToInt32(result1));
        Assert.Equal(2, Convert.ToInt32(result2));
        Assert.Equal("Red", result0.ToString());
        Assert.Equal("Green", result1.ToString());
        Assert.Equal("Blue", result2.ToString());
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_conv_emit_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
