// <copyright file="DataStructInteropTests.cs" company="GSharp">
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

/// Issue #242: validates that data struct types emitted by gsc are consumable
/// from external .NET code (C#/F#). The emitted TypeDef must have correct
/// base-type assembly references (System.Runtime, not System.Private.CoreLib)
/// and valid ECMA-335 methodList monotonicity so the CLR can load the type.
open class DataStructInteropTests {
    @Fact
    func DataStruct_LoadsViaReflection_AndFieldsAreAccessible() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        Assert.True(point.IsValueType)
        Assert.Equal("System.ValueType", point.BaseType?.FullName)
        let instance object? = Activator.CreateInstance(point)
        let xField FieldInfo? = point.GetField("X")
        let yField FieldInfo? = point.GetField("Y")
        Assert.NotNull(xField)
        Assert.NotNull(yField)
        xField!!.SetValue(instance, 42)
        yField!!.SetValue(instance, 99)
        Assert.Equal(42, xField!!.GetValue(instance))
        Assert.Equal(99, yField!!.GetValue(instance))
    }

    @Fact
    func DataStruct_BaseTypeRef_PointsToSystemRuntime() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}`
        let assembly = CompileToAssembly(source)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        // The base type must resolve to System.ValueType — if the assembly
        // reference pointed at System.Private.CoreLib, the type would fail
        // to load entirely (CS0012 at compile time, TypeLoadException at
        // runtime in some scenarios).
        Assert.Equal("System.ValueType", point.BaseType?.FullName)
        Assert.True(point.IsValueType)
    }

    @Fact
    func DataStruct_CoexistsWithInlineStruct_WithoutTypeLoadException() {
        // Issue #242 root cause: when a data struct preceded an inline struct
        // in the TypeDef table, the methodList pointers violated ECMA-335
        // monotonicity. As of ADR-0029 / Issue #410 a data struct emits 7
        // synthesized methods and an inline struct emits 7 + ctor, so both
        // contribute non-empty method ranges; this test pins the monotonicity
        // invariant so any future change to the method count surfaces here.
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}

inline struct UserId(value int32)`
        let assembly = CompileToAssembly(source)
        // GetTypes() would throw ReflectionTypeLoadException if metadata is invalid.
        let types = assembly.GetTypes()
        Assert.Contains(types, (t Type) -> t.Name == "Point")
        Assert.Contains(types, (t Type) -> t.Name == "UserId")
        let point = types.Single((t Type) -> t.Name == "Point")
        Assert.True(point.IsValueType)
        let instance object? = Activator.CreateInstance(point)
        point.GetField("X")!!.SetValue(instance, 7)
        Assert.Equal(7, point.GetField("X")!!.GetValue(instance))
    }

    @Fact
    func DataStruct_CoexistsWithClassAndInlineStruct() {
        let source = `package MyLib
import System

data struct Point {
    var X int32
    var Y int32
}

inline struct UserId(value int32)

class Foo {
    var Name string
    var Count int32
}`
        let assembly = CompileToAssembly(source)
        let types = assembly.GetTypes()
        Assert.Contains(types, (t Type) -> t.Name == "Point")
        Assert.Contains(types, (t Type) -> t.Name == "UserId")
        Assert.Contains(types, (t Type) -> t.Name == "Foo")
        // Verify all types are usable.
        let point = types.Single((t Type) -> t.Name == "Point")
        Assert.True(point.IsValueType)
        let foo = types.Single((t Type) -> t.Name == "Foo")
        Assert.False(foo.IsValueType)
        let fooInstance object? = Activator.CreateInstance(foo)
        Assert.NotNull(fooInstance)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_datastruct_interop_").FullName
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
