// <copyright file="PropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0051 Phase 8: compiler emit tests for property declarations.
/// Validates that compiled assemblies contain correct PropertyDef metadata
/// and that property accessors work at runtime via reflection.
/// </summary>
public class PropertyEmitTests
{
    [Fact]
    public void AutoProperty_EmitsPropertyDef_WithGetterAndSetter()
    {
        var source = """
            package MyLib
            import System

            class Person {
                prop Name string
            }
            """;

        var assembly = CompileToAssembly(source);
        var person = assembly.GetTypes().Single(t => t.Name == "Person");
        var prop = person.GetProperty("Name");

        Assert.NotNull(prop);
        Assert.Equal(typeof(string), prop!.PropertyType);
        Assert.True(prop.CanRead);
        Assert.True(prop.CanWrite);
        Assert.Equal("get_Name", prop.GetMethod!.Name);
        Assert.Equal("set_Name", prop.SetMethod!.Name);
        Assert.True(prop.GetMethod.IsSpecialName);
        Assert.True(prop.SetMethod.IsSpecialName);
    }

    [Fact]
    public void AutoProperty_HasBackingField()
    {
        var source = """
            package MyLib
            import System

            class Person {
                prop Name string
            }
            """;

        var assembly = CompileToAssembly(source);
        var person = assembly.GetTypes().Single(t => t.Name == "Person");
        var backingField = person.GetField("<Name>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(backingField);
        Assert.Equal(typeof(string), backingField!.FieldType);
        Assert.True(backingField.IsPrivate);
    }

    [Fact]
    public void AutoProperty_ReadOnly_EmitsOnlyGetter()
    {
        var source = """
            package MyLib
            import System

            class Foo {
                prop X int32 { get }
            }
            """;

        var assembly = CompileToAssembly(source);
        var foo = assembly.GetTypes().Single(t => t.Name == "Foo");
        var prop = foo.GetProperty("X");

        Assert.NotNull(prop);
        Assert.True(prop!.CanRead);
        Assert.False(prop.CanWrite);
        Assert.NotNull(prop.GetMethod);
        Assert.Null(prop.SetMethod);
    }

    [Fact]
    public void AutoProperty_RoundTrip_SetAndGet()
    {
        var source = """
            package MyLib
            import System

            class Box {
                prop Item string
            }
            """;

        var assembly = CompileToAssembly(source);
        var boxType = assembly.GetTypes().Single(t => t.Name == "Box");
        var instance = Activator.CreateInstance(boxType);
        var prop = boxType.GetProperty("Item");

        Assert.NotNull(prop);
        prop!.SetMethod!.Invoke(instance, new object[] { "hello" });
        var result = prop.GetMethod!.Invoke(instance, null);
        Assert.Equal("hello", result);
    }

    [Fact]
    public void AutoProperty_RoundTrip_Int32()
    {
        var source = """
            package MyLib
            import System

            class Counter {
                prop Value int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType);
        var prop = counterType.GetProperty("Value");

        Assert.NotNull(prop);
        prop!.SetMethod!.Invoke(instance, new object[] { 42 });
        var result = prop.GetMethod!.Invoke(instance, null);
        Assert.Equal(42, result);
    }

    [Fact]
    public void MultipleProperties_EmitCorrectly()
    {
        var source = """
            package MyLib
            import System

            class Person {
                prop Name string
                prop Age int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var person = assembly.GetTypes().Single(t => t.Name == "Person");

        var nameProp = person.GetProperty("Name");
        var ageProp = person.GetProperty("Age");

        Assert.NotNull(nameProp);
        Assert.NotNull(ageProp);
        Assert.Equal(typeof(string), nameProp!.PropertyType);
        Assert.Equal(typeof(int), ageProp!.PropertyType);

        // Round-trip both properties
        var instance = Activator.CreateInstance(person);
        nameProp.SetMethod!.Invoke(instance, new object[] { "Alice" });
        ageProp.SetMethod!.Invoke(instance, new object[] { 30 });
        Assert.Equal("Alice", nameProp.GetMethod!.Invoke(instance, null));
        Assert.Equal(30, ageProp.GetMethod!.Invoke(instance, null));
    }

    [Fact]
    public void VirtualProperty_EmitsVirtualAccessors()
    {
        var source = """
            package MyLib
            import System

            open class Base {
                open prop Label string
            }
            """;

        var assembly = CompileToAssembly(source);
        var baseType = assembly.GetTypes().Single(t => t.Name == "Base");
        var prop = baseType.GetProperty("Label");

        Assert.NotNull(prop);
        Assert.True(prop!.GetMethod!.IsVirtual);
        Assert.True(prop.SetMethod!.IsVirtual);
    }

    [Fact]
    public void OverrideProperty_EmitsOverrideAccessors()
    {
        var source = """
            package MyLib
            import System

            open class Base {
                open prop Label string
            }

            class Derived : Base {
                override prop Label string
            }
            """;

        var assembly = CompileToAssembly(source);
        var derivedType = assembly.GetTypes().Single(t => t.Name == "Derived");
        var prop = derivedType.GetProperty("Label");

        Assert.NotNull(prop);
        Assert.True(prop!.GetMethod!.IsVirtual);
        // Override should not have NewSlot
        Assert.False((prop.GetMethod.Attributes & MethodAttributes.NewSlot) != 0);
    }

    [Fact]
    public void InterfaceProperty_CompilesWithoutError()
    {
        // Interface property declarations compile and emit PropertyDef metadata.
        var source = """
            package MyLib
            import System

            interface Named {
                prop Name string { get }
            }
            """;

        var assembly = CompileToAssembly(source);
        var namedType = assembly.GetTypes().Single(t => t.Name == "Named");
        Assert.True(namedType.IsInterface);

        // Issue #248: PropertyDef row must be emitted.
        var prop = namedType.GetProperty("Name");
        Assert.NotNull(prop);
        Assert.NotNull(prop!.GetMethod);
        Assert.Equal("get_Name", prop.GetMethod!.Name);
    }

    [Fact]
    public void Property_DefaultValue_IsZeroForInt32()
    {
        var source = """
            package MyLib
            import System

            class Foo {
                prop Count int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var fooType = assembly.GetTypes().Single(t => t.Name == "Foo");
        var instance = Activator.CreateInstance(fooType);
        var prop = fooType.GetProperty("Count");

        Assert.NotNull(prop);
        var result = prop!.GetMethod!.Invoke(instance, null);
        Assert.Equal(0, result);
    }

    [Fact]
    public void Property_DefaultValue_IsEmptyStringForString()
    {
        // Issue #1714: an unset `string` auto-property backing field is a
        // storage-default site, so it zero-inits to Go-style `""`, not the
        // CLR reference-type default `null`.
        var source = """
            package MyLib
            import System

            class Foo {
                prop Name string
            }
            """;

        var assembly = CompileToAssembly(source);
        var fooType = assembly.GetTypes().Single(t => t.Name == "Foo");
        var instance = Activator.CreateInstance(fooType);
        var prop = fooType.GetProperty("Name");

        Assert.NotNull(prop);
        var result = prop!.GetMethod!.Invoke(instance, null);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void ComputedProperty_Getter_EmitsCorrectIL()
    {
        var source = """
            package MyLib
            import System

            class Rect {
                prop Width int32
                prop Height int32
                prop Area int32 {
                    get {
                        return this.Width * this.Height
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var rectType = assembly.GetTypes().Single(t => t.Name == "Rect");
        var instance = Activator.CreateInstance(rectType);
        rectType.GetProperty("Width")!.SetMethod!.Invoke(instance, new object[] { 3 });
        rectType.GetProperty("Height")!.SetMethod!.Invoke(instance, new object[] { 4 });
        var area = rectType.GetProperty("Area")!.GetMethod!.Invoke(instance, null);
        Assert.Equal(12, area);
    }

    [Fact]
    public void ComputedProperty_Setter_EmitsCorrectIL()
    {
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType);
        counterType.GetProperty("Value")!.SetMethod!.Invoke(instance, new object[] { 5 });
        var result = counterType.GetProperty("Value")!.GetMethod!.Invoke(instance, null);
        Assert.Equal(10, result);
    }

    [Fact]
    public void ComputedProperty_GetOnly_HasNoSetter()
    {
        var source = """
            package MyLib
            import System

            class Greeter {
                prop Name string
                prop Greeting string {
                    get {
                        return "Hello, " + this.Name
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var greeterType = assembly.GetTypes().Single(t => t.Name == "Greeter");
        var instance = Activator.CreateInstance(greeterType);
        greeterType.GetProperty("Name")!.SetMethod!.Invoke(instance, new object[] { "World" });
        var greetingProp = greeterType.GetProperty("Greeting");
        Assert.NotNull(greetingProp);
        Assert.True(greetingProp!.CanRead);
        Assert.False(greetingProp.CanWrite);
        var result = greetingProp.GetMethod!.Invoke(instance, null);
        Assert.Equal("Hello, World", result);
    }

    [Fact]
    public void AccessorAccessibility_EmitsMetadataAndRunsInsideDeclaringType()
    {
        var source = """
            package MyLib
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
            }
            """;

        var assembly = CompileToAssembly(source);
        var type = assembly.GetTypes().Single(t => t.Name == "ApplEnv");
        var property = type.GetProperty("ApplName");

        Assert.NotNull(property);
        Assert.True(property!.GetMethod!.IsPublic);
        Assert.True(property.GetMethod.IsStatic);
        Assert.True(property.GetSetMethod(nonPublic: true)!.IsPrivate);
        Assert.True(property.GetSetMethod(nonPublic: true)!.IsStatic);
        var nullability = new NullabilityInfoContext().Create(property);
        Assert.Equal(NullabilityState.Nullable, nullability.ReadState);
        Assert.Equal(NullabilityState.Nullable, nullability.WriteState);

        type.GetMethod("Override")!.Invoke(null, new object[] { "Foundation" });
        Assert.Equal("Foundation", property.GetValue(null));
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_property_emit_").FullName;
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
