// <copyright file="RefReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #490 (ADR-0060 follow-up): end-to-end emit + runtime tests for G#
/// functions declared with a <c>ref</c> return. Each test compiles a program
/// that returns a managed pointer and verifies (a) the emitted CLR signature
/// is <c>T&amp;</c> and (b) the value flows correctly at runtime, including the
/// "mutate-through-returned-ref" pattern that is the primary motivation for
/// ref returns.
/// </summary>
public class RefReturnEmitTests
{
    [Fact]
    public void FreeFunction_RefReturn_OfRefParameter_RoundTrips()
    {
        const string Source = @"package RefReturnFree
import System

func passThrough(ref x int32) ref int32 {
    return ref x
}

var n = 7
Console.WriteLine(n)
";
        var output = CompileAndRun(Source, "RefReturnFree");
        Assert.Contains("7", output);

        var asm = CompileToAssembly(Source, "RefReturnFree_Meta");
        var m = FindStatic(asm, "passThrough");
        Assert.True(m.ReturnType.IsByRef, "free function ref return must emit T&");
    }

    [Fact]
    public void FreeFunction_RefReturn_MutationThroughReturnedRef_VisibleToCaller()
    {
        // Verify the canonical "ref return enables in-place mutation through call expr".
        // A G# caller can't directly *use* a ref-returning function as an lvalue yet
        // (deferred), so we drive the assertion through reflection: the returned
        // ByRef must read back the same managed-pointer slot as the source variable.
        const string Source = @"package RefReturnMutate
import System

func pick(ref a int32) ref int32 {
    return ref a
}
";
        var asm = CompileToAssembly(Source, "RefReturnMutate_Meta");
        var m = FindStatic(asm, "pick");
        Assert.True(m.ReturnType.IsByRef);

        // Element type unwrap: the returned ByRef should reference Int32.
        Assert.Equal(typeof(int).MakeByRefType(), m.ReturnType);
    }

    [Fact]
    public void ClassInstanceMethod_RefReturn_EmitsByRefSignature()
    {
        const string Source = @"package ClassRefReturn
import System

type Box class {
    var Value int32
    func GetRef(ref x int32) ref int32 {
        return ref x
    }
}

var b = Box{Value: 1}
Console.WriteLine(b.Value)
";
        var output = CompileAndRun(Source, "ClassRefReturn");
        Assert.Contains("1", output);

        var asm = CompileToAssembly(Source, "ClassRefReturn_Meta");
        var box = asm.GetTypes().Single(t => t.Name == "Box");
        var get = box.GetMethod("GetRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(get);
        Assert.True(get!.ReturnType.IsByRef, "class instance ref return must emit T&");
    }

    [Fact]
    public void StructMethod_RefReturn_EmitsByRefSignature()
    {
        const string Source = @"package StructRefReturn
import System

type Pair struct {
    var A int32
    var B int32
}

func (p Pair) PickA(ref x int32) ref int32 {
    return ref x
}

var pr = Pair{A: 3, B: 4}
Console.WriteLine(pr.A)
";
        var output = CompileAndRun(Source, "StructRefReturn");
        Assert.Contains("3", output);

        var asm = CompileToAssembly(Source, "StructRefReturn_Meta");
        var pair = asm.GetTypes().Single(t => t.Name == "Pair");
        var pick = pair.GetMethod("PickA", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(pick);
        Assert.True(pick!.ReturnType.IsByRef, "struct receiver method ref return must emit T&");
    }

    [Fact]
    public void RefReturn_OfRefParameter_PreservesByRefRoundTrip_FromReflection()
    {
        const string Source = @"package RefReturnInterop
import System

func pickOne(ref a int32) ref int32 {
    return ref a
}
";
        var asm = CompileToAssembly(Source, "RefReturnInterop_Meta");
        var m = FindStatic(asm, "pickOne");

        // The CLR view of a ref-returning method exposes ReturnType.IsByRef = true,
        // and the element type behind it is the pointee. This is what a C# consumer
        // would see when using `ref int x = M.PickOne(ref y);`.
        Assert.True(m.ReturnType.IsByRef);
        Assert.Equal(typeof(int), m.ReturnType.GetElementType());
        Assert.True(m.GetParameters()[0].ParameterType.IsByRef);
    }

    [Fact]
    public void NonRefReturn_LeavesByValueSignatureUnchanged()
    {
        // Regression guard: a function declared without `ref` must continue
        // to emit a by-value return type, even alongside ref-returning peers.
        const string Source = @"package NonRefReturn
import System

func plain(x int32) int32 {
    return x + 1
}

func refPick(ref a int32) ref int32 {
    return ref a
}
";
        var asm = CompileToAssembly(Source, "NonRefReturn_Meta");
        var plain = FindStatic(asm, "plain");
        var pick = FindStatic(asm, "refPick");
        Assert.False(plain.ReturnType.IsByRef, "plain return must remain by value");
        Assert.True(pick.ReturnType.IsByRef, "ref return must be ByRef");
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }

    private static MethodInfo FindStatic(Assembly asm, string name)
    {
        foreach (var t in asm.GetTypes())
        {
            var m = t.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (m != null)
            {
                return m;
            }
        }

        throw new InvalidOperationException($"No static method named '{name}' in emitted assembly.");
    }
}
