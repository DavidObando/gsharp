// <copyright file="EnumEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #193 emit tests. Compiles GSharp sources declaring user-defined enums
/// and asserts that the resulting PE contains a CLR enum TypeDef (sealed value
/// type derived from (cref:System.Enum)) with the expected
/// `value__` field plus one literal field per member, and that user
/// annotations on the enum type or its members survive the round-trip as
/// `CustomAttribute` rows.
open class EnumEmitTests {
    @Fact
    func Enum_Emits_As_ClrEnum_With_Int_Underlying() {
        let source = `package P
import System

enum Color { Red, Green, Blue }`
        let assembly = CompileToAssembly(source)
        let color = assembly.GetTypes().Single((t Type) -> t.Name == "Color")
        Assert.True(color.IsEnum, "Emitted Color must be a CLR enum.")
        Assert.Equal(typeof(int32), Enum.GetUnderlyingType(color))
        Assert.True(color.IsSealed)
        Assert.Equal("P", color.Namespace)
        let names = Enum.GetNames(color)
        Assert.Equal([]string{"Red", "Green", "Blue"}, names)
        let values = Enum.GetValues(color).Cast[object]().Select((v object) -> Convert.ToInt32(v)).ToArray()
        Assert.Equal([]int32{0, 1, 2}, values)
    }

    @Fact
    func Enum_Member_Constants_Match_Auto_Numbering() {
        let source = `package P
import System

enum Pri { Low, Medium, High }`
        let assembly = CompileToAssembly(source)
        let pri = assembly.GetTypes().Single((t Type) -> t.Name == "Pri")
        // Each member should round-trip as a literal field carrying its int.
        let literalFields = pri
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where((f FieldInfo) -> f.IsLiteral)
            .OrderBy((f FieldInfo) -> Convert.ToInt32(f.GetRawConstantValue()))
            .ToArray()
        Assert.Equal(3, literalFields.Length)
        Assert.Equal("Low", literalFields[0].Name)
        Assert.Equal(0, Convert.ToInt32(literalFields[0].GetRawConstantValue()))
        Assert.Equal("Medium", literalFields[1].Name)
        Assert.Equal(1, Convert.ToInt32(literalFields[1].GetRawConstantValue()))
        Assert.Equal("High", literalFields[2].Name)
        Assert.Equal(2, Convert.ToInt32(literalFields[2].GetRawConstantValue()))
        // value__ instance field exists and is int32 with SpecialName / RTSpecialName.
        let valueField FieldInfo? = pri.GetField("value__", BindingFlags.Instance | BindingFlags.Public)
        Assert.NotNull(valueField)
        Assert.Equal(typeof(int32), valueField!!.FieldType)
        Assert.True((valueField!!.Attributes & FieldAttributes.SpecialName) != 0)
        Assert.True((valueField!!.Attributes & FieldAttributes.RTSpecialName) != 0)
    }

    @Fact
    func Obsolete_On_Enum_Member_Round_Trips_As_CustomAttribute_On_Field() {
        // Issue #188 / #193: @Obsolete on an enum member must end up as a
        // CustomAttribute on the literal field row, observable via reflection.
        let source = `package P
import System

enum Color {
    Red,
    @Obsolete("use Red")
    Crimson,
    Blue,
}`
        let assembly = CompileToAssembly(source)
        let color = assembly.GetTypes().Single((t Type) -> t.Name == "Color")
        let crimson FieldInfo? = color.GetField("Crimson", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(crimson)
        let data = crimson!!.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("use Red", arg.Value)
    }

    @Fact
    func Obsolete_On_Enum_Type_Round_Trips_As_CustomAttribute_On_TypeDef() {
        let source = `package P
import System

@Obsolete("legacy enum")
enum Color { Red, Green }`
        let assembly = CompileToAssembly(source)
        let color = assembly.GetTypes().Single((t Type) -> t.Name == "Color")
        let data = color.GetCustomAttributesData().Single(
            (d CustomAttributeData) -> d.AttributeType.FullName == "System.ObsoleteAttribute"
        )
        let arg = Assert.Single(data.ConstructorArguments)
        Assert.Equal("legacy enum", arg.Value)
    }

    @Fact
    func Enum_Appears_In_Function_Signature_As_TypeDef() {
        // The public signature surface of `func Pick(c Color) Color` should
        // reference the enum's TypeDef rather than int32.
        let source = `package P
import System

enum Color { Red, Green, Blue }

func Pick(c Color) Color {
    return c
}`
        let assembly = CompileToAssembly(source)
        let color = assembly.GetTypes().Single((t Type) -> t.Name == "Color")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let pick MethodInfo? = program.GetMethod(
            "Pick",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(pick)
        let parameters = pick!!.GetParameters()
        Assert.Single(parameters)
        Assert.Equal(color, parameters[0].ParameterType)
        Assert.Equal(color, pick!!.ReturnType)
    }

    @Fact
    func Enum_Literal_Field_Type_Is_Enum_TypeDef_With_Preceding_Structs() {
        // Issue #420 (P3-8): the literal field signatures must reference the
        // enum's own TypeDef. Previously this handle was computed
        // speculatively from GetRowCount(TypeDef)+1 before the row was
        // added; this test exercises the case where multiple structs (with
        // their own field rows) are emitted before the enum so a row-count
        // off-by-one would surface as a wrong literal field type.
        let source = `package P
import System

data struct S1 {
    var A int32
    var B int32
}
data struct S2 {
    var X int32
    var Y int32
    var Z int32
}
data struct S3 {
    var N int32
}

enum Color { Red, Green, Blue }`
        let assembly = CompileToAssembly(source)
        let color = assembly.GetTypes().Single((t Type) -> t.Name == "Color")
        // value__ is int32; literal members must be typed as Color itself.
        let literalFields = color
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where((f FieldInfo) -> f.IsLiteral)
            .ToArray()
        Assert.Equal(3, literalFields.Length)
        for lit in literalFields {
            Assert.Equal(color, lit.FieldType)
        }
        // Reading the values via reflection must work (CLR validates the
        // literal field signature points at the enum's actual TypeDef).
        let red = Enum.Parse(color, "Red")
        let green = Enum.Parse(color, "Green")
        let blue = Enum.Parse(color, "Blue")
        Assert.Equal(0, Convert.ToInt32(red))
        Assert.Equal(1, Convert.ToInt32(green))
        Assert.Equal(2, Convert.ToInt32(blue))
    }

    @Fact
    func Multiple_Enums_Each_Use_Their_Own_TypeDef_For_Literals() {
        // If TypeDef handles were computed speculatively and the emit order
        // changed, two adjacent enums could end up with their literal fields
        // typed against the wrong sibling enum. Verify each enum's literals
        // resolve to that enum's own TypeDef.
        let source = `package P
import System

enum A { A0, A1 }
enum B { B0, B1, B2 }
enum C { C0 }`
        let assembly = CompileToAssembly(source)
        let a = assembly.GetTypes().Single((t Type) -> t.Name == "A")
        let b = assembly.GetTypes().Single((t Type) -> t.Name == "B")
        let c = assembly.GetTypes().Single((t Type) -> t.Name == "C")
        for lit in a.GetFields(BindingFlags.Public | BindingFlags.Static).Where((f FieldInfo) -> f.IsLiteral) {
            Assert.Equal(a, lit.FieldType)
        }
        for lit in b.GetFields(BindingFlags.Public | BindingFlags.Static).Where((f FieldInfo) -> f.IsLiteral) {
            Assert.Equal(b, lit.FieldType)
        }
        for lit in c.GetFields(BindingFlags.Public | BindingFlags.Static).Where((f FieldInfo) -> f.IsLiteral) {
            Assert.Equal(c, lit.FieldType)
        }
        Assert.Equal([]string{"A0", "A1"}, Enum.GetNames(a))
        Assert.Equal([]string{"B0", "B1", "B2"}, Enum.GetNames(b))
        Assert.Equal([]string{"C0"}, Enum.GetNames(c))
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_enum_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }
    }
}
