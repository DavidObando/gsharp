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
