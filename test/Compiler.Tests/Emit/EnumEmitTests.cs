// <copyright file="EnumEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #193 emit tests. Compiles GSharp sources declaring user-defined enums
/// and asserts that the resulting PE contains a CLR enum TypeDef (sealed value
/// type derived from <see cref="System.Enum"/>) with the expected
/// <c>value__</c> field plus one literal field per member, and that user
/// annotations on the enum type or its members survive the round-trip as
/// <c>CustomAttribute</c> rows.
/// </summary>
public class EnumEmitTests
{
    [Fact]
    public void Enum_Emits_As_ClrEnum_With_Int_Underlying()
    {
        var source = """
            package P
            import System

            type Color enum { Red, Green, Blue }
            """;

        var assembly = CompileToAssembly(source);
        var color = assembly.GetTypes().Single(t => t.Name == "Color");

        Assert.True(color.IsEnum, "Emitted Color must be a CLR enum.");
        Assert.Equal(typeof(int), Enum.GetUnderlyingType(color));
        Assert.True(color.IsSealed);
        Assert.Equal("P", color.Namespace);

        var names = Enum.GetNames(color);
        Assert.Equal(new[] { "Red", "Green", "Blue" }, names);

        var values = Enum.GetValues(color).Cast<object>().Select(v => Convert.ToInt32(v)).ToArray();
        Assert.Equal(new[] { 0, 1, 2 }, values);
    }

    [Fact]
    public void Enum_Member_Constants_Match_Auto_Numbering()
    {
        var source = """
            package P
            import System

            type Pri enum { Low, Medium, High }
            """;

        var assembly = CompileToAssembly(source);
        var pri = assembly.GetTypes().Single(t => t.Name == "Pri");

        // Each member should round-trip as a literal field carrying its int.
        var literalFields = pri.GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .OrderBy(f => Convert.ToInt32(f.GetRawConstantValue()))
            .ToArray();

        Assert.Equal(3, literalFields.Length);
        Assert.Equal("Low", literalFields[0].Name);
        Assert.Equal(0, Convert.ToInt32(literalFields[0].GetRawConstantValue()));
        Assert.Equal("Medium", literalFields[1].Name);
        Assert.Equal(1, Convert.ToInt32(literalFields[1].GetRawConstantValue()));
        Assert.Equal("High", literalFields[2].Name);
        Assert.Equal(2, Convert.ToInt32(literalFields[2].GetRawConstantValue()));

        // value__ instance field exists and is int32 with SpecialName / RTSpecialName.
        var valueField = pri.GetField("value__", BindingFlags.Instance | BindingFlags.Public);
        Assert.NotNull(valueField);
        Assert.Equal(typeof(int), valueField.FieldType);
        Assert.True((valueField.Attributes & FieldAttributes.SpecialName) != 0);
        Assert.True((valueField.Attributes & FieldAttributes.RTSpecialName) != 0);
    }

    [Fact]
    public void Obsolete_On_Enum_Member_Round_Trips_As_CustomAttribute_On_Field()
    {
        // Issue #188 / #193: @Obsolete on an enum member must end up as a
        // CustomAttribute on the literal field row, observable via reflection.
        var source = """
            package P
            import System

            type Color enum {
                Red,
                @Obsolete("use Red")
                Crimson,
                Blue,
            }
            """;

        var assembly = CompileToAssembly(source);
        var color = assembly.GetTypes().Single(t => t.Name == "Color");
        var crimson = color.GetField("Crimson", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(crimson);

        var data = crimson.GetCustomAttributesData().Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("use Red", arg.Value);
    }

    [Fact]
    public void Obsolete_On_Enum_Type_Round_Trips_As_CustomAttribute_On_TypeDef()
    {
        var source = """
            package P
            import System

            @Obsolete("legacy enum")
            type Color enum { Red, Green }
            """;

        var assembly = CompileToAssembly(source);
        var color = assembly.GetTypes().Single(t => t.Name == "Color");
        var data = color.GetCustomAttributesData().Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("legacy enum", arg.Value);
    }

    [Fact]
    public void Enum_Appears_In_Function_Signature_As_TypeDef()
    {
        // The public signature surface of `func Pick(c Color) Color` should
        // reference the enum's TypeDef rather than int32.
        var source = """
            package P
            import System

            type Color enum { Red, Green, Blue }

            func Pick(c Color) Color {
                return c
            }
            """;

        var assembly = CompileToAssembly(source);
        var color = assembly.GetTypes().Single(t => t.Name == "Color");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var pick = program.GetMethod("Pick", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(pick);

        var parameters = pick.GetParameters();
        Assert.Single(parameters);
        Assert.Equal(color, parameters[0].ParameterType);
        Assert.Equal(color, pick.ReturnType);
    }

    [Fact]
    public void Enum_Literal_Field_Type_Is_Enum_TypeDef_With_Preceding_Structs()
    {
        // Issue #420 (P3-8): the literal field signatures must reference the
        // enum's own TypeDef. Previously this handle was computed
        // speculatively from GetRowCount(TypeDef)+1 before the row was
        // added; this test exercises the case where multiple structs (with
        // their own field rows) are emitted before the enum so a row-count
        // off-by-one would surface as a wrong literal field type.
        var source = """
            package P
            import System

            type S1 data struct {
                A int32
                B int32
            }
            type S2 data struct {
                X int32
                Y int32
                Z int32
            }
            type S3 data struct {
                N int32
            }

            type Color enum { Red, Green, Blue }
            """;

        var assembly = CompileToAssembly(source);
        var color = assembly.GetTypes().Single(t => t.Name == "Color");

        // value__ is int32; literal members must be typed as Color itself.
        var literalFields = color.GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .ToArray();
        Assert.Equal(3, literalFields.Length);
        foreach (var lit in literalFields)
        {
            Assert.Equal(color, lit.FieldType);
        }

        // Reading the values via reflection must work (CLR validates the
        // literal field signature points at the enum's actual TypeDef).
        var red = Enum.Parse(color, "Red");
        var green = Enum.Parse(color, "Green");
        var blue = Enum.Parse(color, "Blue");
        Assert.Equal(0, Convert.ToInt32(red));
        Assert.Equal(1, Convert.ToInt32(green));
        Assert.Equal(2, Convert.ToInt32(blue));
    }

    [Fact]
    public void Multiple_Enums_Each_Use_Their_Own_TypeDef_For_Literals()
    {
        // If TypeDef handles were computed speculatively and the emit order
        // changed, two adjacent enums could end up with their literal fields
        // typed against the wrong sibling enum. Verify each enum's literals
        // resolve to that enum's own TypeDef.
        var source = """
            package P
            import System

            type A enum { A0, A1 }
            type B enum { B0, B1, B2 }
            type C enum { C0 }
            """;

        var assembly = CompileToAssembly(source);
        var a = assembly.GetTypes().Single(t => t.Name == "A");
        var b = assembly.GetTypes().Single(t => t.Name == "B");
        var c = assembly.GetTypes().Single(t => t.Name == "C");

        foreach (var lit in a.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.IsLiteral))
        {
            Assert.Equal(a, lit.FieldType);
        }

        foreach (var lit in b.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.IsLiteral))
        {
            Assert.Equal(b, lit.FieldType);
        }

        foreach (var lit in c.GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.IsLiteral))
        {
            Assert.Equal(c, lit.FieldType);
        }

        Assert.Equal(new[] { "A0", "A1" }, Enum.GetNames(a));
        Assert.Equal(new[] { "B0", "B1", "B2" }, Enum.GetNames(b));
        Assert.Equal(new[] { "C0" }, Enum.GetNames(c));
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_enum_emit_").FullName;
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
