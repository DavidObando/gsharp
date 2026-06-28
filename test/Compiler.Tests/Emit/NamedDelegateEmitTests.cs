// <copyright file="NamedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0059 / issue #255: compiler emit tests for named delegate type
/// declarations.
/// </summary>
public class NamedDelegateEmitTests
{
    [Fact]
    public void NamedDelegate_EmitsSealedMulticastDelegateTypeDef()
    {
        var source = """
            package MyLib

            type MyHandler = delegate func(a int32, b int32) int32
            """;

        var assembly = CompileToAssembly(source);

        var handler = assembly.GetTypes().Single(t => t.Name == "MyHandler");

        Assert.True(handler.IsSealed, $"{handler.FullName} should be sealed");
        Assert.True(handler.IsClass, $"{handler.FullName} should be a class");
        Assert.NotNull(handler.BaseType);
        Assert.Equal("System.MulticastDelegate", handler.BaseType!.FullName);
    }

    [Fact]
    public void NamedDelegate_EmitsRuntimeCtorWithObjectAndIntPtr()
    {
        var source = """
            package MyLib

            type MyHandler = delegate func(a int32, b int32) int32
            """;

        var assembly = CompileToAssembly(source);
        var handler = assembly.GetTypes().Single(t => t.Name == "MyHandler");

        var ctor = handler.GetConstructors(BindingFlags.Public | BindingFlags.Instance).Single();
        Assert.True(ctor.IsSpecialName);

        var implFlags = ctor.GetMethodImplementationFlags();
        Assert.True(
            (implFlags & MethodImplAttributes.Runtime) == MethodImplAttributes.Runtime,
            "Delegate .ctor must have MethodImplAttributes.Runtime");

        var parms = ctor.GetParameters();
        Assert.Equal(2, parms.Length);
        Assert.Equal(typeof(object), parms[0].ParameterType);
        Assert.Equal(typeof(nint), parms[1].ParameterType);
    }

    [Fact]
    public void NamedDelegate_EmitsRuntimeInvokeMatchingSignature()
    {
        var source = """
            package MyLib

            type MyHandler = delegate func(a int32, b int32) int32
            """;

        var assembly = CompileToAssembly(source);
        var handler = assembly.GetTypes().Single(t => t.Name == "MyHandler");

        var invoke = handler.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(invoke);
        Assert.True(invoke!.IsVirtual);
        Assert.False(invoke.IsAbstract);

        var implFlags = invoke.GetMethodImplementationFlags();
        Assert.True(
            (implFlags & MethodImplAttributes.Runtime) == MethodImplAttributes.Runtime,
            "Delegate Invoke must have MethodImplAttributes.Runtime");

        Assert.Equal(typeof(int), invoke.ReturnType);
        var parms = invoke.GetParameters();
        Assert.Equal(2, parms.Length);
        Assert.Equal(typeof(int), parms[0].ParameterType);
        Assert.Equal(typeof(int), parms[1].ParameterType);
        Assert.Equal("a", parms[0].Name);
        Assert.Equal("b", parms[1].Name);
    }

    [Fact]
    public void VoidNamedDelegate_InvokeReturnsVoid()
    {
        var source = """
            package MyLib

            type Greeter = delegate func(name string)
            """;

        var assembly = CompileToAssembly(source);
        var greeter = assembly.GetTypes().Single(t => t.Name == "Greeter");

        var invoke = greeter.GetMethod("Invoke")!;
        Assert.Equal(typeof(void), invoke.ReturnType);
        Assert.Single(invoke.GetParameters());
        Assert.Equal(typeof(string), invoke.GetParameters()[0].ParameterType);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_named_delegate_emit_").FullName;
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
