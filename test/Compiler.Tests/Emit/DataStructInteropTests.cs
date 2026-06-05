// <copyright file="DataStructInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #242: validates that data struct types emitted by gsc are consumable
/// from external .NET code (C#/F#). The emitted TypeDef must have correct
/// base-type assembly references (System.Runtime, not System.Private.CoreLib)
/// and valid ECMA-335 methodList monotonicity so the CLR can load the type.
/// </summary>
public class DataStructInteropTests
{
    [Fact]
    public void DataStruct_LoadsViaReflection_AndFieldsAreAccessible()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        Assert.True(point.IsValueType);
        Assert.Equal("System.ValueType", point.BaseType?.FullName);

        var instance = Activator.CreateInstance(point);
        var xField = point.GetField("X");
        var yField = point.GetField("Y");
        Assert.NotNull(xField);
        Assert.NotNull(yField);
        xField!.SetValue(instance, 42);
        yField!.SetValue(instance, 99);
        Assert.Equal(42, xField.GetValue(instance));
        Assert.Equal(99, yField.GetValue(instance));
    }

    [Fact]
    public void DataStruct_BaseTypeRef_PointsToSystemRuntime()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var point = assembly.GetTypes().Single(t => t.Name == "Point");

        // The base type must resolve to System.ValueType — if the assembly
        // reference pointed at System.Private.CoreLib, the type would fail
        // to load entirely (CS0012 at compile time, TypeLoadException at
        // runtime in some scenarios).
        Assert.Equal("System.ValueType", point.BaseType?.FullName);
        Assert.True(point.IsValueType);
    }

    [Fact]
    public void DataStruct_CoexistsWithInlineStruct_WithoutTypeLoadException()
    {
        // Issue #242 root cause: when a data struct (no methods) preceded an
        // inline struct (8 synthesized methods, including its ctor) in the TypeDef table, the
        // methodList pointers violated ECMA-335 monotonicity.
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }

            type UserId inline struct(value int32)
            """;

        var assembly = CompileToAssembly(source);

        // GetTypes() would throw ReflectionTypeLoadException if metadata is invalid.
        var types = assembly.GetTypes();
        Assert.Contains(types, t => t.Name == "Point");
        Assert.Contains(types, t => t.Name == "UserId");

        var point = types.Single(t => t.Name == "Point");
        Assert.True(point.IsValueType);
        var instance = Activator.CreateInstance(point);
        point.GetField("X")!.SetValue(instance, 7);
        Assert.Equal(7, point.GetField("X")!.GetValue(instance));
    }

    [Fact]
    public void DataStruct_CoexistsWithClassAndInlineStruct()
    {
        var source = """
            package MyLib
            import System

            type Point data struct {
                X int32
                Y int32
            }

            type UserId inline struct(value int32)

            type Foo class {
                Name string
                Count int32
            }
            """;

        var assembly = CompileToAssembly(source);
        var types = assembly.GetTypes();
        Assert.Contains(types, t => t.Name == "Point");
        Assert.Contains(types, t => t.Name == "UserId");
        Assert.Contains(types, t => t.Name == "Foo");

        // Verify all types are usable.
        var point = types.Single(t => t.Name == "Point");
        Assert.True(point.IsValueType);

        var foo = types.Single(t => t.Name == "Foo");
        Assert.False(foo.IsValueType);
        var fooInstance = Activator.CreateInstance(foo);
        Assert.NotNull(fooInstance);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_datastruct_interop_").FullName;
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
        IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.GenericValueTypeDispatch);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
