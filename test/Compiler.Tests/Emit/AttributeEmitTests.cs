// <copyright file="AttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 3 emit tests for issue #141 / ADR-0047. Compiles GSharp sources that
/// carry user annotations and asserts that the resulting PE contains the
/// expected <c>CustomAttribute</c> rows by inspecting the loaded assembly's
/// reflection metadata.
/// </summary>
public class AttributeEmitTests
{
    [Fact]
    public void Emits_Obsolete_With_Message_On_Function()
    {
        var source = """
            package P
            import System

            @Obsolete("use Bar instead")
            func Foo() {
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var foo = program.GetMethod("Foo", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(foo);
        var data = foo.GetCustomAttributesData().Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("use Bar instead", arg.Value);
    }

    [Fact]
    public void Emits_Parameterless_Obsolete_On_Function()
    {
        var source = """
            package P
            import System

            @Obsolete
            func Helper() {
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var helper = program.GetMethod("Helper", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(helper);
        Assert.Contains(
            helper.GetCustomAttributesData(),
            d => d.AttributeType.FullName == "System.ObsoleteAttribute");
    }

    [Fact]
    public void Emits_Attribute_On_Struct_TypeDef()
    {
        var source = """
            package P
            import System

            @Obsolete("legacy")
            type Point data struct {
                X int
                Y int
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        var data = point.GetCustomAttributesData().Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("legacy", arg.Value);
    }

    [Fact]
    public void AttributeSugar_Emits_Class_With_SystemAttribute_Base()
    {
        var source = """
            package P
            import System

            @Attribute
            type Trace class {
            }
            """;

        var assembly = CompileToAssembly(source);
        var trace = assembly.GetTypes().Single(t => t.Name == "Trace");

        Assert.Equal("System.Attribute", trace.BaseType?.FullName);
        Assert.True(typeof(System.Attribute).IsAssignableFrom(trace));
    }

    [Fact]
    public void Emits_Typeof_Argument_On_Function()
    {
        // System.Diagnostics.DebuggerTypeProxyAttribute(Type) — exercises the
        // ECMA-335 II.23.3 element-type 0x50 (SerString type-name) encoding.
        var source = """
            package P
            import System
            import System.Diagnostics

            @DebuggerTypeProxy(typeof(int))
            type Box data struct {
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var box = assembly.GetTypes().Single(t => t.Name == "Box");
        var data = box
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.Diagnostics.DebuggerTypeProxyAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal(typeof(Type), arg.ArgumentType);

        // The CLR rehydrates the SerString into either a System.Type or its
        // canonical string name depending on whether the type resolves —
        // accept either, but assert it identifies System.Int32.
        var typeName = arg.Value switch
        {
            Type t => t.FullName,
            string s => s,
            _ => null,
        };
        Assert.StartsWith("System.Int32", typeName ?? string.Empty);
    }

    [Fact]
    public void Emits_Typeof_Named_Argument()
    {
        // DebuggerDisplayAttribute exposes a settable `Target` property of
        // type System.Type — verifies named-arg encoding of the 0x50 tag.
        var source = """
            package P
            import System
            import System.Diagnostics

            @DebuggerDisplay("{Value}", Target = typeof(string))
            type Holder data struct {
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var holder = assembly.GetTypes().Single(t => t.Name == "Holder");
        var data = holder
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.Diagnostics.DebuggerDisplayAttribute");

        var targetNamed = Assert.Single(data.NamedArguments, n => n.MemberName == "Target");
        Assert.Equal(typeof(Type), targetNamed.TypedValue.ArgumentType);
        var typeName = targetNamed.TypedValue.Value switch
        {
            Type t => t.FullName,
            string s => s,
            _ => null,
        };
        Assert.StartsWith("System.String", typeName ?? string.Empty);
    }

    [Fact]
    public void Emits_Object_Argument_Carrying_Boxed_Int()
    {
        // DefaultValueAttribute(object) is the canonical boxed-object ctor —
        // the emitter must precede the FixedArg with the runtime type tag
        // (ECMA-335 II.23.3 element-type 0x51).
        var source = """
            package P
            import System
            import System.ComponentModel

            @DefaultValue(42)
            type Counter data struct {
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var counter = assembly.GetTypes().Single(t => t.Name == "Counter");
        var data = counter
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        // CustomAttributeData unboxes a 0x51-wrapped value to its runtime element type.
        Assert.Equal(typeof(int), arg.ArgumentType);
        Assert.Equal(42, arg.Value);
    }

    [Fact]
    public void Emits_Object_Argument_Carrying_String()
    {
        var source = """
            package P
            import System
            import System.ComponentModel

            @DefaultValue("hello")
            type Greeter data struct {
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var greeter = assembly.GetTypes().Single(t => t.Name == "Greeter");
        var data = greeter
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal(typeof(string), arg.ArgumentType);
        Assert.Equal("hello", arg.Value);
    }

    [Fact]
    public void Emits_Array_Argument()
    {
        // TupleElementNamesAttribute(string[]) — exercises the ECMA-335
        // II.23.3 SZARRAY (0x1D) encoding for a string-array positional arg.
        var source = """
            package P
            import System
            import System.Runtime.CompilerServices

            @TupleElementNames([]string{"first", "second"})
            type Pair data struct {
                A int
                B int
            }
            """;

        var assembly = CompileToAssembly(source);
        var pair = assembly.GetTypes().Single(t => t.Name == "Pair");
        var data = pair
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        var values = ((System.Collections.ObjectModel.ReadOnlyCollection<System.Reflection.CustomAttributeTypedArgument>)arg.Value)
            .Select(v => (string)v.Value)
            .ToArray();
        Assert.Equal(new[] { "first", "second" }, values);
    }

    [Fact]
    public void Emits_Object_Argument_Carrying_Type()
    {
        // DefaultValueAttribute(object) carrying a `typeof(T)` — verifies the
        // recursive 0x51-boxed encoding nests a 0x50 type-name SerString.
        var source = """
            package P
            import System
            import System.ComponentModel

            @DefaultValue(typeof(int))
            type Holder data struct {
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var holder = assembly.GetTypes().Single(t => t.Name == "Holder");
        var data = holder
            .GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ComponentModel.DefaultValueAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal(typeof(Type), arg.ArgumentType);
        var typeName = arg.Value switch
        {
            Type t => t.FullName,
            string s => s,
            _ => null,
        };
        Assert.StartsWith("System.Int32", typeName ?? string.Empty);
    }

    [Fact]
    public void Emits_Attribute_On_Parameter()
    {
        // Issue #170 / ADR-0047 §3: per-parameter annotations attach to the
        // Parameter metadata row, round-tripping through
        // `MethodInfo.GetParameters()[i].GetCustomAttributesData()`.
        var source = """
            package P
            import System

            func Foo(@Obsolete("old name") name string) {
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var foo = program.GetMethod("Foo", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(foo);
        var parameters = foo.GetParameters();
        var nameParam = Assert.Single(parameters);
        Assert.Equal("name", nameParam.Name);

        var data = nameParam.GetCustomAttributesData().Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("old name", arg.Value);

        // The MethodDef itself should not carry the parameter-target attribute.
        Assert.DoesNotContain(
            foo.GetCustomAttributesData(),
            d => d.AttributeType.FullName == "System.ObsoleteAttribute");
    }

    [Fact]
    public void Emits_Attribute_On_Return_Parameter()
    {
        // Issue #172 / ADR-0047 §3: `@return:` annotations attach to the
        // synthesised sequence-0 Parameter row (ECMA-335 II.22.33), surfacing
        // through `MethodInfo.ReturnParameter.GetCustomAttributesData()`.
        var source = """
            package P
            import System

            @return:Obsolete("old return")
            func Foo() int {
                return 0
            }
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var foo = program.GetMethod("Foo", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(foo);

        var returnParam = foo.ReturnParameter;
        Assert.NotNull(returnParam);
        var data = returnParam.GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("old return", arg.Value);

        // The MethodDef itself should not carry the return-target attribute.
        Assert.DoesNotContain(
            foo.GetCustomAttributesData(),
            d => d.AttributeType.FullName == "System.ObsoleteAttribute");
    }

    [Fact]
    public void Emits_Obsolete_On_Struct_Field()
    {
        // Issue #186: `@Obsolete` on a field declaration round-trips to a
        // CustomAttribute row on the field's FieldDef.
        var source = """
            package P
            import System

            type Point data struct {
                @Obsolete("use NewX")
                X int
                Y int
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        var xField = point.GetField("X", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(xField);
        var data = xField.GetCustomAttributesData()
            .Single(d => d.AttributeType.FullName == "System.ObsoleteAttribute");
        var arg = Assert.Single(data.ConstructorArguments);
        Assert.Equal("use NewX", arg.Value);

        // Sibling field carries no attribute rows.
        var yField = point.GetField("Y", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(yField);
        Assert.DoesNotContain(
            yField.GetCustomAttributesData(),
            d => d.AttributeType.FullName == "System.ObsoleteAttribute");
    }

    [Fact]
    public void Emits_Obsolete_On_Class_Field()
    {
        // Issue #186: same round-trip for class-declared fields. Verifies the
        // EmitNestedStructTypeDef-shared field-emit path also writes the row.
        var source = """
            package P
            import System

            type Box class {
                @Obsolete("retired")
                Value int
            }
            """;

        var assembly = CompileToAssembly(source);
        var box = assembly.GetTypes().Single(t => t.Name == "Box");
        var valueField = box.GetField("Value", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(valueField);
        Assert.Contains(
            valueField.GetCustomAttributesData(),
            d => d.AttributeType.FullName == "System.ObsoleteAttribute");
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_attr_emit_").FullName;
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

        // Read all bytes so the file isn't locked, then load via Assembly.Load.
        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
