// <copyright file="InlineStructEqualsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #420 (P3-10): the inline-struct <c>Equals(object)</c> emitter in
/// <c>ReflectionMetadataEmitter</c> uses the <c>unbox</c> IL opcode, which is
/// legal only for value-type targets. These tests pin down the current
/// value-type contract by exercising <c>Equals(object)</c> on a compiled
/// inline struct and verifying the resulting type is in fact a value type, so
/// the assumption documented at the emit site cannot drift silently.
/// </summary>
public class InlineStructEqualsEmitTests
{
    [Fact]
    public void InlineStruct_EqualsObject_ReturnsTrueForSameValue()
    {
        var source = """
            package MyLib
            import System

            type UserId inline struct(value int32)
            """;

        var assembly = CompileToAssembly(source);
        var userId = assembly.GetTypes().Single(t => t.Name == "UserId");

        // The unbox opcode used by the synthesized Equals(object) is only valid
        // for value types — guard the assumption from the production code here.
        Assert.True(userId.IsValueType, "UserId inline struct must be emitted as a value type.");

        var a = MakeUserId(userId, 42);
        var b = MakeUserId(userId, 42);
        var c = MakeUserId(userId, 7);

        var equalsObject = userId.GetMethod("Equals", new[] { typeof(object) });
        Assert.NotNull(equalsObject);

        Assert.True((bool)equalsObject!.Invoke(a, new[] { b })!);
        Assert.False((bool)equalsObject.Invoke(a, new[] { c })!);
        Assert.False((bool)equalsObject.Invoke(a, new object[] { null! })!);
        Assert.False((bool)equalsObject.Invoke(a, new object[] { "not a UserId" })!);
    }

    private static object MakeUserId(Type userId, int value)
    {
        // Inline structs do not expose a public parameterized constructor we
        // can invoke via reflection — construct via the default ctor and set
        // the backing field directly.
        var instance = Activator.CreateInstance(userId)!;
        var field = userId.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Single();
        field.SetValue(instance, value);
        return instance;
    }

    [Fact]
    public void InlineStruct_EqualsObject_HasObjectParameter()
    {
        var source = """
            package MyLib
            import System

            type UserId inline struct(value int32)
            """;

        var assembly = CompileToAssembly(source);
        var userId = assembly.GetTypes().Single(t => t.Name == "UserId");

        var equalsObject = userId.GetMethod("Equals", new[] { typeof(object) });
        Assert.NotNull(equalsObject);
        Assert.Equal(typeof(bool), equalsObject!.ReturnType);
        Assert.Equal(typeof(object), equalsObject.GetParameters().Single().ParameterType);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_inline_equals_").FullName;
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
