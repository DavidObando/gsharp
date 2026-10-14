// <copyright file="PropertyEmitTests.cs" company="GSharp">
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

/// ADR-0051 Phase 8: compiler emit tests for property declarations.
/// Validates that compiled assemblies contain correct PropertyDef metadata
/// and that property accessors work at runtime via reflection.
open class PropertyEmitTests {
    @Fact
    func AutoProperty_EmitsPropertyDef_WithGetterAndSetter() {
        let source = `package MyLib
import System

class Person {
    prop Name string
}`
        let assembly = CompileToAssembly(source)
        let person = assembly.GetTypes().Single((t Type) -> t.Name == "Person")
        let prop PropertyInfo? = person.GetProperty("Name")
        Assert.NotNull(prop)
        Assert.Equal(typeof(string), prop!!.PropertyType)
        Assert.True(prop!!.CanRead)
        Assert.True(prop!!.CanWrite)
        Assert.Equal("get_Name", prop!!.GetMethod!!.Name)
        Assert.Equal("set_Name", prop!!.SetMethod!!.Name)
        Assert.True(prop!!.GetMethod!!.IsSpecialName)
        Assert.True(prop!!.SetMethod!!.IsSpecialName)
    }

    @Fact
    func AutoProperty_HasBackingField() {
        let source = `package MyLib
import System

class Person {
    prop Name string
}`
        let assembly = CompileToAssembly(source)
        let person = assembly.GetTypes().Single((t Type) -> t.Name == "Person")
        let backingField FieldInfo? = person.GetField(
            "<Name>k__BackingField",
            BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(backingField)
        Assert.Equal(typeof(string), backingField!!.FieldType)
        Assert.True(backingField!!.IsPrivate)
    }

    @Fact
    func AutoProperty_ReadOnly_EmitsOnlyGetter() {
        let source = `package MyLib
import System

class Foo {
    prop X int32 { get }
}`
        let assembly = CompileToAssembly(source)
        let foo = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        let prop PropertyInfo? = foo.GetProperty("X")
        Assert.NotNull(prop)
        Assert.True(prop!!.CanRead)
        Assert.False(prop!!.CanWrite)
        Assert.NotNull(prop!!.GetMethod)
        Assert.Null(prop!!.SetMethod)
    }

    @Fact
    func AutoProperty_RoundTrip_SetAndGet() {
        let source = `package MyLib
import System

class Box {
    prop Item string
}`
        let assembly = CompileToAssembly(source)
        let boxType = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let instance object? = Activator.CreateInstance(boxType)
        let prop PropertyInfo? = boxType.GetProperty("Item")
        Assert.NotNull(prop)
        prop!!.SetMethod!!.Invoke(instance, []object{"hello"})
        let result object? = prop!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal("hello", result)
    }

    @Fact
    func AutoProperty_RoundTrip_Int32() {
        let source = `package MyLib
import System

class Counter {
    prop Value int32
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance object? = Activator.CreateInstance(counterType)
        let prop PropertyInfo? = counterType.GetProperty("Value")
        Assert.NotNull(prop)
        prop!!.SetMethod!!.Invoke(instance, []object{42})
        let result object? = prop!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal(42, result)
    }

    @Fact
    func MultipleProperties_EmitCorrectly() {
        let source = `package MyLib
import System

class Person {
    prop Name string
    prop Age int32
}`
        let assembly = CompileToAssembly(source)
        let person = assembly.GetTypes().Single((t Type) -> t.Name == "Person")
        let nameProp PropertyInfo? = person.GetProperty("Name")
        let ageProp PropertyInfo? = person.GetProperty("Age")
        Assert.NotNull(nameProp)
        Assert.NotNull(ageProp)
        Assert.Equal(typeof(string), nameProp!!.PropertyType)
        Assert.Equal(typeof(int32), ageProp!!.PropertyType)
        // Round-trip both properties
        let instance object? = Activator.CreateInstance(person)
        nameProp!!.SetMethod!!.Invoke(instance, []object{"Alice"})
        ageProp!!.SetMethod!!.Invoke(instance, []object{30})
        Assert.Equal("Alice", nameProp!!.GetMethod!!.Invoke(instance, nil))
        Assert.Equal(30, ageProp!!.GetMethod!!.Invoke(instance, nil))
    }

    @Fact
    func VirtualProperty_EmitsVirtualAccessors() {
        let source = `package MyLib
import System

open class Base {
    open prop Label string
}`
        let assembly = CompileToAssembly(source)
        let baseType = assembly.GetTypes().Single((t Type) -> t.Name == "Base")
        let prop PropertyInfo? = baseType.GetProperty("Label")
        Assert.NotNull(prop)
        Assert.True(prop!!.GetMethod!!.IsVirtual)
        Assert.True(prop!!.SetMethod!!.IsVirtual)
    }

    @Fact
    func OverrideProperty_EmitsOverrideAccessors() {
        let source = `package MyLib
import System

open class Base {
    open prop Label string
}

class Derived : Base {
    override prop Label string
}`
        let assembly = CompileToAssembly(source)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "Derived")
        let prop PropertyInfo? = derivedType.GetProperty("Label")
        Assert.NotNull(prop)
        Assert.True(prop!!.GetMethod!!.IsVirtual)
        // Override should not have NewSlot
        Assert.False((prop!!.GetMethod!!.Attributes & MethodAttributes.NewSlot) != 0)
    }

    @Fact
    func InterfaceProperty_CompilesWithoutError() {
        // Interface property declarations compile and emit PropertyDef metadata.
        let source = `package MyLib
import System

interface Named {
    prop Name string { get }
}`
        let assembly = CompileToAssembly(source)
        let namedType = assembly.GetTypes().Single((t Type) -> t.Name == "Named")
        Assert.True(namedType.IsInterface)
        // Issue #248: PropertyDef row must be emitted.
        let prop PropertyInfo? = namedType.GetProperty("Name")
        Assert.NotNull(prop)
        Assert.NotNull(prop!!.GetMethod)
        Assert.Equal("get_Name", prop!!.GetMethod!!.Name)
    }

    @Fact
    func Property_DefaultValue_IsZeroForInt32() {
        let source = `package MyLib
import System

class Foo {
    prop Count int32
}`
        let assembly = CompileToAssembly(source)
        let fooType = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        let instance object? = Activator.CreateInstance(fooType)
        let prop PropertyInfo? = fooType.GetProperty("Count")
        Assert.NotNull(prop)
        let result object? = prop!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal(0, result)
    }

    @Fact
    func Property_DefaultValue_IsNullForString() {
        let source = `package MyLib
import System

class Foo {
    prop Name string
}`
        let assembly = CompileToAssembly(source)
        let fooType = assembly.GetTypes().Single((t Type) -> t.Name == "Foo")
        let instance object? = Activator.CreateInstance(fooType)
        let prop PropertyInfo? = fooType.GetProperty("Name")
        Assert.NotNull(prop)
        let result object? = prop!!.GetMethod!!.Invoke(instance, nil)
        Assert.Null(result)
    }

    @Fact
    func ComputedProperty_Getter_EmitsCorrectIL() {
        let source = `package MyLib
import System

class Rect {
    prop Width int32
    prop Height int32
    prop Area int32 {
        get {
            return this.Width * this.Height
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let rectType = assembly.GetTypes().Single((t Type) -> t.Name == "Rect")
        let instance object? = Activator.CreateInstance(rectType)
        rectType.GetProperty("Width")!!.SetMethod!!.Invoke(instance, []object{3})
        rectType.GetProperty("Height")!!.SetMethod!!.Invoke(instance, []object{4})
        let area object? = rectType.GetProperty("Area")!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal(12, area)
    }

    @Fact
    func ComputedProperty_Setter_EmitsCorrectIL() {
        let source = `package MyLib
import System

class Counter {
    prop raw int32
    prop Value int32 {
        get {
            return this.raw * 2
        }
        set(v) {
            this.raw = v
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance object? = Activator.CreateInstance(counterType)
        counterType.GetProperty("Value")!!.SetMethod!!.Invoke(instance, []object{5})
        let result object? = counterType.GetProperty("Value")!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal(10, result)
    }

    @Fact
    func ComputedProperty_GetOnly_HasNoSetter() {
        let source = `package MyLib
import System

class Greeter {
    prop Name string
    prop Greeting string {
        get {
            return "Hello, " + this.Name
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let greeterType = assembly.GetTypes().Single((t Type) -> t.Name == "Greeter")
        let instance object? = Activator.CreateInstance(greeterType)
        greeterType.GetProperty("Name")!!.SetMethod!!.Invoke(instance, []object{"World"})
        let greetingProp PropertyInfo? = greeterType.GetProperty("Greeting")
        Assert.NotNull(greetingProp)
        Assert.True(greetingProp!!.CanRead)
        Assert.False(greetingProp!!.CanWrite)
        let result object? = greetingProp!!.GetMethod!!.Invoke(instance, nil)
        Assert.Equal("Hello, World", result)
    }

    @Fact
    func AccessorAccessibility_EmitsMetadataAndRunsInsideDeclaringType() {
        let source = `package MyLib
import System

class ApplEnv {
    shared {
        private var _name string? = nil
        prop ApplName string? {
            get { return _name }
            private set { _name = value }
        }
        func Override(name string?) {
            ApplName = name
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let type = assembly.GetTypes().Single((t Type) -> t.Name == "ApplEnv")
        let property PropertyInfo? = type.GetProperty("ApplName")
        Assert.NotNull(property)
        Assert.True(property!!.GetMethod!!.IsPublic)
        Assert.True(property!!.GetMethod!!.IsStatic)
        Assert.True(property!!.GetSetMethod(nonPublic: true)!!.IsPrivate)
        Assert.True(property!!.GetSetMethod(nonPublic: true)!!.IsStatic)
        let nullability = NullabilityInfoContext().Create(property!!)
        Assert.Equal(NullabilityState.Nullable, nullability.ReadState)
        Assert.Equal(NullabilityState.Nullable, nullability.WriteState)
        type.GetMethod("Override")!!.Invoke(nil, []object{"Foundation"})
        Assert.Equal("Foundation", property!!.GetValue(nil))
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_property_emit_").FullName
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
