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

            enum Color { Red, Green, Blue }

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

            enum Color { Red, Green, Blue }

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

    [Fact]
    public void UInt32_To_Int64_Widens_As_Unsigned_Not_Sign_Extended()
    {
        // Issue #1612: `uint32 -> int64` must zero-extend (conv.u8), not
        // sign-extend (conv.i8). 0xFFFFFFFF as uint32 is 4294967295, and
        // that value must survive the widen unchanged.
        var source = """
            package P

            func ToInt64(value uint32) int64 {
                return int64(value)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var toInt64 = program.GetMethod(
            "ToInt64",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toInt64);

        var result = toInt64!.Invoke(null, new object[] { 0xFFFFFFFFu });
        Assert.Equal(4294967295L, result);
    }

    [Fact]
    public void Int32_To_UInt64_Widens_As_Signed_Sign_Extended()
    {
        // Issue #1612: `int32 -> uint64` must sign-extend (conv.i8), not
        // zero-extend (conv.u8). -1 as int32 must become
        // 0xFFFFFFFFFFFFFFFF, not 0x00000000FFFFFFFF.
        var source = """
            package P

            func ToUInt64(value int32) uint64 {
                return uint64(value)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var toUInt64 = program.GetMethod(
            "ToUInt64",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toUInt64);

        var result = toUInt64!.Invoke(null, new object[] { -1 });
        Assert.Equal(0xFFFFFFFFFFFFFFFFUL, result);
    }

    [Fact]
    public void UInt32_To_NInt_Widens_As_Unsigned_Not_Sign_Extended()
    {
        // Issue #1612 same defect on the native-int target: `uint32 ->
        // nint` must zero-extend.
        var source = """
            package P

            func ToNInt(value uint32) nint {
                return nint(value)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var toNInt = program.GetMethod(
            "ToNInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toNInt);

        var result = toNInt!.Invoke(null, new object[] { 0xFFFFFFFFu });
        Assert.Equal(unchecked((nint)4294967295L), result);
    }

    [Fact]
    public void Int32_To_NUInt_Widens_As_Signed_Sign_Extended()
    {
        // Issue #1612 same defect on the native-uint target: `int32 ->
        // nuint` must sign-extend.
        var source = """
            package P

            func ToNUInt(value int32) nuint {
                return nuint(value)
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var toNUInt = program.GetMethod(
            "ToNUInt",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(toNUInt);

        var result = toNUInt!.Invoke(null, new object[] { -1 });
        Assert.Equal(unchecked((nuint)0xFFFFFFFFFFFFFFFFUL), result);
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
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
