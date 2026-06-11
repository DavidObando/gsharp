// <copyright file="RefStructGenericFieldEmitTests.cs" company="GSharp">
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
/// Issue #375 / ADR-0056 §4: a user <c>ref struct</c> embedding a *closed*
/// constructed generic value-type field (<c>ReadOnlySpan[int32]</c>) must be
/// laid out with its real layout and its members accessed by managed pointer.
/// </summary>
/// <remarks>
/// Two facets are proven here:
/// <list type="number">
/// <item>The emitted field carries the real constructed-generic value type
/// (<c>System.ReadOnlySpan&lt;int&gt;</c>) and is never erased to
/// <c>System.Object</c> (no boxing/erasure substitution).</item>
/// <item>Reading <c>w.data.Length</c> loads the field by *address*
/// (<c>ldflda</c>, IL opcode 0x7C) rather than by value (<c>ldfld</c>, 0x7B):
/// calling an instance method on a value type requires a <c>this</c> managed
/// pointer, and the value form corrupted the stack
/// (<see cref="AccessViolationException"/>). The program runs and prints the
/// span length.</item>
/// </list>
/// </remarks>
public class RefStructGenericFieldEmitTests
{
    private const string WindowSource = @"package RefStructGenericField
import System
type Window ref struct {
    var data ReadOnlySpan[int32]
}
func firstLen(w Window) int32 {
    return w.data.Length
}
func Main() {
    var nums []int32 = []int32{10, 20, 30}
    var span ReadOnlySpan[int32] = nums
    var w Window = Window{data: span}
    Console.WriteLine(firstLen(w))
}
";

    [Fact]
    public void ClosedGenericValueTypeField_HasRealLayout_NotErasedToObject()
    {
        var asm = Compile(WindowSource, nameof(this.ClosedGenericValueTypeField_HasRealLayout_NotErasedToObject));

        var window = asm.GetTypes().FirstOrDefault(t => t.Name == "Window");
        Assert.NotNull(window);
        Assert.True(window!.IsValueType);

        var field = window.GetField("data", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(field);

        // The field must carry the real, closed constructed generic value type,
        // never erased to System.Object (ADR-0056 §4).
        Assert.NotEqual(typeof(object), field!.FieldType);
        Assert.True(field.FieldType.IsValueType);
        Assert.True(field.FieldType.IsGenericType);
        Assert.Equal(typeof(System.ReadOnlySpan<int>), field.FieldType);
    }

    [Fact]
    public void InstanceMemberOnValueTypeField_LoadsAddress_NotValue()
    {
        var asm = Compile(WindowSource, nameof(this.InstanceMemberOnValueTypeField_LoadsAddress_NotValue));

        var program = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(program);
        var firstLen = program!.GetMethod(
            "firstLen",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(firstLen);

        var il = firstLen!.GetMethodBody()!.GetILAsByteArray();
        Assert.NotNull(il);

        // The first field opcode in firstLen must be ldflda (0x7C, load field
        // address), not ldfld (0x7B, load field value): the value-type field is
        // the receiver of an instance call and must be loaded by managed
        // pointer. Loading it by value was the bug (corrupt `this` -> AV).
        // firstLen is tiny: ldarga.s w; ldflda data; call get_Length; ret.
        var firstFieldOpcode = il!.FirstOrDefault(b => b == 0x7B || b == 0x7C);
        Assert.Equal((byte)0x7C, firstFieldOpcode);
    }

    [Fact]
    public void RefStructWithGenericField_ConstructsAndReadsLength_NoFault()
    {
        var asm = Compile(WindowSource, nameof(this.RefStructWithGenericField_ConstructsAndReadsLength_NoFault));

        var entry = asm.EntryPoint;
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

        Assert.Equal("3", captured.ToString().Trim());
    }

    private static Assembly Compile(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: false);
        return loadContext.LoadFromStream(peStream);
    }
}
