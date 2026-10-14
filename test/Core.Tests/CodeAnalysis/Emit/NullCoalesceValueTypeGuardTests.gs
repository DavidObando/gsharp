// <copyright file="NullCoalesceValueTypeGuardTests.cs" company="GSharp">
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

/// Issue #420 / P3-5: the null-coalesce (`??`) emit path uses
/// `dup; brtrue` which is only legal for object references and primitive
/// integers — it is invalid IL for struct stack values (including
/// `Nullable<T>` over a value type).
///
/// Issue #519 retired the historical fail-fast guard for value-type
/// `Nullable<T>` operands by lowering them to a HasValue/get_Value
/// sequence over a pre-allocated scratch slot. This file now pins down both
/// behaviours that survived the change:
/// - Reference-type operands continue to short-circuit correctly via the existing `dup; brtrue`
/// pattern.
/// - Value-type `Nullable<T>` operands now compile and run correctly through the HasValue path (and
/// produce verifiable IL — see `Issue519CoalesceNullableEmitTests` in the Compiler.Tests project for
/// the ilverify-gated end-to-end shape).
open class NullCoalesceValueTypeGuardTests {
    @Fact
    func NullCoalesce_ReferenceType_LeftNonNil_ReturnsLeft() {
        const Source = `package NullCoalesceRefNonNil
import System
var s string? = "hello"
var r string = s ?? "fallback"
Console.WriteLine(r)
`
        let stdout = CompileLoadInvokeCaptureStdout(Source, "NullCoalesce_ReferenceType_LeftNonNil_ReturnsLeft")
        Assert.Equal("hello", stdout.Trim())
    }

    @Fact
    func NullCoalesce_ReferenceType_LeftNil_ReturnsRight() {
        const Source = `package NullCoalesceRefNil
import System
var s string? = nil
var r string = s ?? "fallback"
Console.WriteLine(r)
`
        let stdout = CompileLoadInvokeCaptureStdout(Source, "NullCoalesce_ReferenceType_LeftNil_ReturnsRight")
        Assert.Equal("fallback", stdout.Trim())
    }

    @Fact
    func NullCoalesce_ValueType_LeftNullableInt_LeftNil_ReturnsRight() {
        // Issue #519: `int? ?? 0` previously aborted emit because `dup;
        // brtrue` is invalid IL for the `Nullable<int>` struct on the
        // stack. The emitter now spills the LHS into a pre-allocated
        // `Nullable<int>` slot and branches on `Nullable<T>::get_HasValue`,
        // producing verifiable IL that returns the right operand when the
        // left is absent.
        const Source = `package NullCoalesceValueTypeNil
import System
var n int32? = nil
var r int32 = n ?? 99
Console.WriteLine(r)
`
        let stdout = CompileLoadInvokeCaptureStdout(
            Source,
            "NullCoalesce_ValueType_LeftNullableInt_LeftNil_ReturnsRight"
        )
        Assert.Equal("99", stdout.Trim())
    }

    @Fact
    func NullCoalesce_ValueType_LeftNullableInt_LeftPresent_ReturnsUnderlying() {
        // Symmetric case: when the LHS carries a value, the result is the
        // underlying primitive — fetched via `Nullable<T>::get_Value()` off
        // the spilled slot's address (the same path PR #541 added for `!!`).
        const Source = `package NullCoalesceValueTypePresent
import System
var n int32? = 7
var r int32 = n ?? 99
Console.WriteLine(r)
`
        let stdout = CompileLoadInvokeCaptureStdout(
            Source,
            "NullCoalesce_ValueType_LeftNullableInt_LeftPresent_ReturnsUnderlying"
        )
        Assert.Equal("7", stdout.Trim())
    }

    shared {
        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let originalOut = Console.Out
                using let sw = StringWriter()
                Console.SetOut(sw)
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
                    Console.SetOut(originalOut)
                }
                return sw.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
