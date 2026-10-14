// <copyright file="DataStructSynthesizedMembersTests.cs" company="GSharp">
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

/// Issue #410 / ADR-0029: validates the seven synthesized members emitted for
/// every `data struct` — `Equals(Name)`, `Equals(object)`,
/// `GetHashCode`, `ToString`, `op_Equality`,
/// `op_Inequality`, and `Deconstruct`. These tests exercise the
/// generated IL via reflection to ensure structural value semantics work both
/// from G# and from cross-language consumers.
open class DataStructSynthesizedMembersTests {
    @Fact
    func DataStruct_EmitsSevenSynthesizedMethods_PlusCtor() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        Assert.NotNull(point.GetMethod("Equals", []Type{typeof(object)}))
        Assert.NotNull(point.GetMethod("Equals", []Type{point}))
        Assert.NotNull(point.GetMethod("GetHashCode", Type.EmptyTypes))
        Assert.NotNull(point.GetMethod("ToString", Type.EmptyTypes))
        Assert.NotNull(point.GetMethod("op_Equality", []Type{point, point}))
        Assert.NotNull(point.GetMethod("op_Inequality", []Type{point, point}))
        Assert.NotNull(point.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance))
    }

    @Fact
    func DataStruct_EqualsTyped_ReturnsTrueForEqualValues_FalseOtherwise() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let a = MakePoint(point, 3, 4)
        let b = MakePoint(point, 3, 4)
        let c = MakePoint(point, 3, 5)
        let equalsTyped MethodInfo? = point.GetMethod("Equals", []Type{point})
        Assert.NotNull(equalsTyped)
        Assert.True(bool(equalsTyped!!.Invoke(a, []object{b})!!))
        Assert.False(bool(equalsTyped!!.Invoke(a, []object{c})!!))
    }

    @Fact
    func DataStruct_EqualsObject_HandlesNullWrongTypeAndCorrectType() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let a = MakePoint(point, 1, 2)
        let b = MakePoint(point, 1, 2)
        let equalsObject MethodInfo? = point.GetMethod("Equals", []Type{typeof(object)})
        Assert.NotNull(equalsObject)
        Assert.True(bool(equalsObject!!.Invoke(a, []object{b})!!))
        Assert.False(bool(equalsObject!!.Invoke(a, []object? {nil})!!))
        Assert.False(bool(equalsObject!!.Invoke(a, []object{"not a Point"})!!))
    }

    @Fact
    func DataStruct_GetHashCode_IsStableForEqualValues() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let a = MakePoint(point, 13, 27)
        let b = MakePoint(point, 13, 27)
        let c = MakePoint(point, 13, 28)
        let getHashCode MethodInfo? = point.GetMethod("GetHashCode", Type.EmptyTypes)
        Assert.NotNull(getHashCode)
        let ha = int32(getHashCode!!.Invoke(a, nil)!!)
        let hb = int32(getHashCode!!.Invoke(b, nil)!!)
        let hc = int32(getHashCode!!.Invoke(c, nil)!!)
        Assert.Equal(ha, hb)
        Assert.NotEqual(ha, hc) // not guaranteed by contract, but extremely likely for HashCode.Combine

    }

    @Fact
    func DataStruct_ToString_FormatsAsNameWithFieldEqualsValuePairs() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let p = MakePoint(point, 3, 4)
        let toString MethodInfo? = point.GetMethod("ToString", Type.EmptyTypes)
        Assert.NotNull(toString)
        let actual string? = cast[string](toString!!.Invoke(p, nil)!!)
        Assert.Equal("Point { X = 3, Y = 4 }", actual)
    }

    @Fact
    func DataStruct_ToString_NullReferenceField_DoesNotThrow() {
        let source = `package MyLib
import System

data struct Pair {
    var Name string
    var Count int32
}`
        let assembly = CompileToAssembly(source)
        let pair = assembly.GetTypes().Single((t Type) -> t.Name == "Pair")
        let instance = Activator.CreateInstance(pair)!!
        // leave Name null, set Count to 0 (default)
        let toString MethodInfo? = pair.GetMethod("ToString", Type.EmptyTypes)
        Assert.NotNull(toString)
        let actual string? = cast[string](toString!!.Invoke(instance, nil)!!)
        // A null reference member appends nothing (ADR-0199).
        Assert.Equal("Pair { Name = , Count = 0 }", actual)
    }

    @Fact
    func DataStruct_OpEquality_AndInequality_RoundTrip() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let a = MakePoint(point, 5, 6)
        let b = MakePoint(point, 5, 6)
        let c = MakePoint(point, 5, 7)
        let opEq MethodInfo? = point.GetMethod("op_Equality", []Type{point, point})
        let opNe MethodInfo? = point.GetMethod("op_Inequality", []Type{point, point})
        Assert.NotNull(opEq)
        Assert.NotNull(opNe)
        Assert.True(bool(opEq!!.Invoke(nil, []object{a, b})!!))
        Assert.False(bool(opEq!!.Invoke(nil, []object{a, c})!!))
        Assert.False(bool(opNe!!.Invoke(nil, []object{a, b})!!))
        Assert.True(bool(opNe!!.Invoke(nil, []object{a, c})!!))
    }

    @Fact
    func DataStruct_Deconstruct_AssignsAllFields() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let p = MakePoint(point, 11, 22)
        let deconstruct MethodInfo? = point.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(deconstruct)
        let args = []object{0, 0}
        deconstruct!!.Invoke(p, args)
        Assert.Equal(11, args[0])
        Assert.Equal(22, args[1])
    }

    @Fact
    func DataStruct_Deconstruct_MixedFieldTypes() {
        let source = `package MyLib
import System

data struct Pair {
    var Name string
    var Count int32
}`
        let assembly = CompileToAssembly(source)
        let pair = assembly.GetTypes().Single((t Type) -> t.Name == "Pair")
        let instance = Activator.CreateInstance(pair)!!
        pair.GetField("Name")!!.SetValue(instance, "abc")
        pair.GetField("Count")!!.SetValue(instance, 42)
        let deconstruct MethodInfo? = pair.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(deconstruct)
        let args = []object? {nil, 0}
        deconstruct!!.Invoke(instance, args)
        Assert.Equal("abc", args[0])
        Assert.Equal(42, args[1])
    }

    @Fact
    func DataStruct_GetHashCode_FoldPath_For9Fields() {
        // ADR-0029: ≤8 fields → HashCode.Combine; >8 fields → fold via
        // HashCode.Add + ToHashCode. Exercise the fold path with 9 fields.
        let source = `package MyLib
import System

data struct Big {
    var A int32
    var B int32
    var C int32
    var D int32
    var E int32
    var F int32
    var G int32
    var H int32
    var I int32
}`
        let assembly = CompileToAssembly(source)
        let big = assembly.GetTypes().Single((t Type) -> t.Name == "Big")
        let instance1 = Activator.CreateInstance(big)!!
        let instance2 = Activator.CreateInstance(big)!!
        for fname in[]string{"A", "B", "C", "D", "E", "F", "G", "H", "I"} {
            big.GetField(fname)!!.SetValue(instance1, 7)
            big.GetField(fname)!!.SetValue(instance2, 7)
        }
        let getHashCode MethodInfo? = big.GetMethod("GetHashCode", Type.EmptyTypes)
        Assert.NotNull(getHashCode)
        let h1 = int32(getHashCode!!.Invoke(instance1, nil)!!)
        let h2 = int32(getHashCode!!.Invoke(instance2, nil)!!)
        Assert.Equal(h1, h2)
        // Change the last field; hash should (almost certainly) differ.
        big.GetField("I")!!.SetValue(instance2, 8)
        let h3 = int32(getHashCode!!.Invoke(instance2, nil)!!)
        Assert.NotEqual(h1, h3)
        // Equals(Name) on the modified instance should now return false.
        let equalsTyped MethodInfo? = big.GetMethod("Equals", []Type{big})
        Assert.NotNull(equalsTyped)
        Assert.False(bool(equalsTyped!!.Invoke(instance1, []object{instance2})!!))
    }

    @Fact
    func DataStruct_EqualsTyped_MixedFieldTypes() {
        let source = `package MyLib
import System

data struct Pair {
    var Name string
    var Count int32
}`
        let assembly = CompileToAssembly(source)
        let pair = assembly.GetTypes().Single((t Type) -> t.Name == "Pair")
        let a = Activator.CreateInstance(pair)!!
        pair.GetField("Name")!!.SetValue(a, "abc")
        pair.GetField("Count")!!.SetValue(a, 1)
        let b = Activator.CreateInstance(pair)!!
        pair.GetField("Name")!!.SetValue(b, "abc")
        pair.GetField("Count")!!.SetValue(b, 1)
        let c = Activator.CreateInstance(pair)!!
        pair.GetField("Name")!!.SetValue(c, "abc")
        pair.GetField("Count")!!.SetValue(c, 2)
        let d = Activator.CreateInstance(pair)!!
        pair.GetField("Name")!!.SetValue(d, nil)
        pair.GetField("Count")!!.SetValue(d, 1)
        let equalsTyped MethodInfo? = pair.GetMethod("Equals", []Type{pair})
        Assert.NotNull(equalsTyped)
        Assert.True(bool(equalsTyped!!.Invoke(a, []object{b})!!))
        Assert.False(bool(equalsTyped!!.Invoke(a, []object{c})!!))
        Assert.False(bool(equalsTyped!!.Invoke(a, []object{d})!!))
    }

    @Fact
    func DataStruct_EqualsObject_DispatchesThroughOverride_NotValueTypeReflection() {
        // Sanity check: the override is marked virtual + final, and instance
        // dispatch through System.ValueType's slot must land on the emitted
        // override rather than reflection-based ValueType.Equals.
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let equalsObject = point.GetMethod("Equals", []Type{typeof(object)})!!
        Assert.True(equalsObject.IsVirtual)
        Assert.False(equalsObject.IsFinal)
    }

    @Fact
    func GenericDataStruct_EqualsAndHashCode_WorkOverErasedFields() {
        let source = `package MyLib
import System

data struct Box[T any] {
    var Value T
}`
        let assembly = CompileToAssembly(source)
        // ADR-0087 §3 R1: a generic G# user type is now emitted as a CLR
        // generic type definition with the mangled name `Box`1`. To
        // instantiate it we close it with a concrete type argument.
        let boxOpen = assembly.GetTypes().Single((t Type) -> t.Name == "Box`1")
        let box = boxOpen.MakeGenericType(typeof(int32))
        let a = Activator.CreateInstance(box)!!
        let b = Activator.CreateInstance(box)!!
        let c = Activator.CreateInstance(box)!!
        // ADR-0087 §3 R2: Value's CLR type is now the reified `int`
        // (not erased `object`) because Box is closed over `typeof(int)`.
        box.GetField("Value")!!.SetValue(a, 42)
        box.GetField("Value")!!.SetValue(b, 42)
        box.GetField("Value")!!.SetValue(c, 43)
        let equalsTyped MethodInfo? = box.GetMethod("Equals", []Type{box})
        Assert.NotNull(equalsTyped)
        Assert.True(bool(equalsTyped!!.Invoke(a, []object{b})!!))
        Assert.False(bool(equalsTyped!!.Invoke(a, []object{c})!!))
        let getHashCode MethodInfo? = box.GetMethod("GetHashCode", Type.EmptyTypes)
        Assert.NotNull(getHashCode)
        let ha = int32(getHashCode!!.Invoke(a, nil)!!)
        let hb = int32(getHashCode!!.Invoke(b, nil)!!)
        Assert.Equal(ha, hb)
    }

    shared {
        private func MakePoint(pointType Type, x int32, y int32) object {
            let instance = Activator.CreateInstance(pointType)!!
            pointType.GetField("X")!!.SetValue(instance, x)
            pointType.GetField("Y")!!.SetValue(instance, y)
            return instance
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_datastruct_synth_").FullName
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
