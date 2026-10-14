// <copyright file="NullConditionalValueTypeEmitTests.cs" company="GSharp">
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

/// Issue #421 / P2-7: null-conditional `s?.M()` over a value-type
/// member result must produce a `Nullable<T>` stack value on
/// both branches. The nil branch materializes `default(Nullable<T>)`
/// via `ldloca`/`initobj`; the not-null branch wraps the raw
/// `T` via `newobj Nullable<T>::.ctor(!0)`. Without this
/// fix, the nil branch pushes a ref-typed `ldnull` while the not-null
/// branch pushes a raw `int32`, producing invalid IL.
open class NullConditionalValueTypeEmitTests {
    @Fact
    func NullConditional_OnNonNullRef_ProducesNullableValueType() {
        // Reading the static field via reflection avoids brittleness around
        // overload resolution for Console.WriteLine(Nullable<int>).
        let source = `
package NullCondValueTypeNonNull
import System

var n int32? = "hello"?.Length
`
        let n object? = CompileLoadInvokeReadField(
            source,
            "NullConditional_OnNonNullRef_ProducesNullableValueType",
            "n"
        )
        Assert.Equal(5, int32(int32?(n)))
    }

    @Fact
    func NullConditional_OnNilRef_ProducesEmptyNullable() {
        let source = `
package NullCondValueTypeNil
import System

var s string? = nil
var n int32? = s?.Length
`
        let n object? = CompileLoadInvokeReadField(source, "NullConditional_OnNilRef_ProducesEmptyNullable", "n")
        Assert.Null(n)
    }

    @Fact
    func NullConditional_OnNonNullRef_NullableField_HasValueAndValue() {
        // Verify the emitted Nullable<int> is a real value-type Nullable —
        // its field signature must be Nullable<int> and runtime Value is 2.
        let source = `
package NullCondValueTypeShape
import System

var s string? = "hi"
var n int32? = s?.Length
`
        using let peStream = MemoryStream()
        let result = Compile(source, peStream)
        Assert.True(result.Success)
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "NullConditional_OnNonNullRef_NullableField_HasValueAndValue",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let field FieldInfo? = programType!!.GetField(
                "n",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(field)
            Assert.Equal(typeof(int32?), field!!.FieldType)
            let entry MethodInfo? = programType!!.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            // GetValue on a Nullable<T> field unboxes to T or returns null.
            let boxed object? = field!!.GetValue(nil)
            Assert.NotNull(boxed)
            Assert.Equal(2, int32(boxed!!))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func NullConditional_OnNilRef_FieldType_IsNullableInt() {
        // The static backing field for `var n int32? = ...` must be
        // emitted with signature `Nullable<int32>`, not raw `int32`.
        let source = `
package NullCondValueTypeFieldType
import System

var s string? = nil
var n int32? = s?.Length
`
        let fieldType = CompileLoadGetFieldType(source, "NullConditional_OnNilRef_FieldType_IsNullableInt", "n")
        Assert.Equal(typeof(int32?), fieldType)
    }

    shared {
        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeReadField(source string, contextName string, fieldName string) object? {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
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
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
                let field FieldInfo? = programType!!.GetField(
                    fieldName,
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(field)
                return field!!.GetValue(nil)
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileLoadGetFieldType(source string, contextName string, fieldName string) Type {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
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
                let field FieldInfo? = programType!!.GetField(
                    fieldName,
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(field)
                return field!!.FieldType
            } finally {
                loadContext.Unload()
            }
        }
    }
}
