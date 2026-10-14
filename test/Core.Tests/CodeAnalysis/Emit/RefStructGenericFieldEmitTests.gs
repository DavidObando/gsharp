// <copyright file="RefStructGenericFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #375 / ADR-0056 §4: a user `ref struct` embedding a *closed*
/// constructed generic value-type field (`ReadOnlySpan[int32]`) must be
/// laid out with its real layout and its members accessed by managed pointer.
/// @remarks Two facets are proven here:
/// 1. The emitted field carries the real constructed-generic value type (`System.ReadOnlySpan<int>`)
/// and is never erased to `System.Object` (no boxing/erasure substitution).
/// 2. Reading `w.data.Length` loads the field by *address* (`ldflda`, IL opcode 0x7C) rather than by
/// value (`ldfld`, 0x7B): calling an instance method on a value type requires a `this` managed pointer,
/// and the value form corrupted the stack ((cref:AccessViolationException)). The program runs and
/// prints the span length.
open class RefStructGenericFieldEmitTests {
    @Fact
    func ClosedGenericValueTypeField_HasRealLayout_NotErasedToObject() {
        let asm = Compile(WindowSource, "ClosedGenericValueTypeField_HasRealLayout_NotErasedToObject")
        let window Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "Window")
        Assert.NotNull(window)
        Assert.True(window!!.IsValueType)
        let field FieldInfo? = window!!.GetField(
            "data",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(field)
        // The field must carry the real, closed constructed generic value type,
        // never erased to System.Object (ADR-0056 §4).
        Assert.NotEqual(typeof(object), field!!.FieldType)
        Assert.True(field!!.FieldType.IsValueType)
        Assert.True(field!!.FieldType.IsGenericType)
        Assert.Equal(typeof(ReadOnlySpan[int32]), field!!.FieldType)
    }

    @Fact
    func InstanceMemberOnValueTypeField_LoadsAddress_NotValue() {
        let asm = Compile(WindowSource, "InstanceMemberOnValueTypeField_LoadsAddress_NotValue")
        let program Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
        Assert.NotNull(program)
        let firstLen MethodInfo? = program!!.GetMethod(
            "firstLen",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(firstLen)
        let il[]?uint8 = firstLen!!.GetMethodBody()!!.GetILAsByteArray()
        Assert.NotNull(il)
        // The first field opcode in firstLen must be ldflda (0x7C, load field
        // address), not ldfld (0x7B, load field value): the value-type field is
        // the receiver of an instance call and must be loaded by managed
        // pointer. Loading it by value was the bug (corrupt `this` -> AV).
        // firstLen is tiny: ldarga.s w; ldflda data; call get_Length; ret.
        let firstFieldOpcode = il!!.FirstOrDefault((b uint8) -> b == uint8(0x7B) || b == uint8(0x7C))
        Assert.Equal(uint8(0x7C), firstFieldOpcode)
    }

    @Fact
    func RefStructWithGenericField_ConstructsAndReadsLength_NoFault() {
        let asm = Compile(WindowSource, "RefStructWithGenericField_ConstructsAndReadsLength_NoFault")
        let entry MethodInfo? = asm.EntryPoint
        Assert.NotNull(entry)
        let stdout = Console.Out
        let captured = StringWriter()
        Console.SetOut(captured)
        try {
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
        } finally {
            Console.SetOut(stdout)
        }
        Assert.Equal("3", captured.ToString().Trim())
    }

    shared {
        private const WindowSource string = `package RefStructGenericField
import System
ref struct Window {
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
`

        private func Compile(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: false)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
