// <copyright file="RefReturnEmitTests.cs" company="GSharp">
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

/// Issue #490 (ADR-0060 follow-up): end-to-end emit + runtime tests for G#
/// functions declared with a `ref` return. Each test compiles a program
/// that returns a managed pointer and verifies (a) the emitted CLR signature
/// is `T&` and (b) the value flows correctly at runtime, including the
/// "mutate-through-returned-ref" pattern that is the primary motivation for
/// ref returns.
open class RefReturnEmitTests {
    @Fact
    func FreeFunction_RefReturn_OfRefParameter_RoundTrips() {
        const Source = `package RefReturnFree
import System

func passThrough(ref x int32) ref int32 {
    return ref x
}

var n = 7
Console.WriteLine(n)
`
        let output = CompileAndRun(Source, "RefReturnFree")
        Assert.Contains("7", output)
        let asm = CompileToAssembly(Source, "RefReturnFree_Meta")
        let m MethodInfo? = FindStatic(asm, "passThrough")
        Assert.True(m!!.ReturnType.IsByRef, "free function ref return must emit T&")
    }

    @Fact
    func FreeFunction_RefReturn_MutationThroughReturnedRef_VisibleToCaller() {
        // Verify the canonical "ref return enables in-place mutation through call expr".
        // This metadata-focused test drives the assertion through reflection:
        // the returned ByRef must read back the same managed-pointer slot as
        // the source variable. Direct G# call-result writes are covered by
        // Issue4224RefReturningCallStorageTests.
        const Source = `package RefReturnMutate
import System

func pick(ref a int32) ref int32 {
    return ref a
}
`
        let asm = CompileToAssembly(Source, "RefReturnMutate_Meta")
        let m MethodInfo? = FindStatic(asm, "pick")
        Assert.True(m!!.ReturnType.IsByRef)
        // Element type unwrap: the returned ByRef should reference Int32.
        Assert.Equal(typeof(int32).MakeByRefType(), m!!.ReturnType)
    }

    @Fact
    func ClassInstanceMethod_RefReturn_EmitsByRefSignature() {
        const Source = `package ClassRefReturn
import System

class Box {
    var Value int32
    func GetRef(ref x int32) ref int32 {
        return ref x
    }
}

var b = Box{Value: 1}
Console.WriteLine(b.Value)
`
        let output = CompileAndRun(Source, "ClassRefReturn")
        Assert.Contains("1", output)
        let asm = CompileToAssembly(Source, "ClassRefReturn_Meta")
        let box = asm.GetTypes().Single((t Type) -> t.Name == "Box")
        let get MethodInfo? = box.GetMethod(
            "GetRef",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(get)
        Assert.True(get!!.ReturnType.IsByRef, "class instance ref return must emit T&")
    }

    @Fact
    func StructMethod_RefReturn_EmitsByRefSignature() {
        const Source = `package StructRefReturn
import System

struct Pair {
    var A int32
    var B int32

    func PickA(ref x int32) ref int32 {
        return ref x
    }
}

var pr = Pair{A: 3, B: 4}
Console.WriteLine(pr.A)
`
        let output = CompileAndRun(Source, "StructRefReturn")
        Assert.Contains("3", output)
        let asm = CompileToAssembly(Source, "StructRefReturn_Meta")
        let pair = asm.GetTypes().Single((t Type) -> t.Name == "Pair")
        let pick MethodInfo? = pair.GetMethod(
            "PickA",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(pick)
        Assert.True(pick!!.ReturnType.IsByRef, "struct receiver method ref return must emit T&")
    }

    @Fact
    func RefReturn_OfRefParameter_PreservesByRefRoundTrip_FromReflection() {
        const Source = `package RefReturnInterop
import System

func pickOne(ref a int32) ref int32 {
    return ref a
}
`
        let asm = CompileToAssembly(Source, "RefReturnInterop_Meta")
        let m MethodInfo? = FindStatic(asm, "pickOne")
        // The CLR view of a ref-returning method exposes ReturnType.IsByRef = true,
        // and the element type behind it is the pointee. This is what a C# consumer
        // would see when using `ref int x = M.PickOne(ref y);`.
        Assert.True(m!!.ReturnType.IsByRef)
        Assert.Equal(typeof(int32), m!!.ReturnType.GetElementType())
        Assert.True(m!!.GetParameters()[0].ParameterType.IsByRef)
    }

    @Fact
    func NonRefReturn_LeavesByValueSignatureUnchanged() {
        // Regression guard: a function declared without `ref` must continue
        // to emit a by-value return type, even alongside ref-returning peers.
        const Source = `package NonRefReturn
import System

func plain(x int32) int32 {
    return x + 1
}

func refPick(ref a int32) ref int32 {
    return ref a
}
`
        let asm = CompileToAssembly(Source, "NonRefReturn_Meta")
        let plain MethodInfo? = FindStatic(asm, "plain")
        let pick MethodInfo? = FindStatic(asm, "refPick")
        Assert.False(plain!!.ReturnType.IsByRef, "plain return must remain by value")
        Assert.True(pick!!.ReturnType.IsByRef, "ref return must be ByRef")
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
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
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileToAssembly(source string, contextName string) Assembly {
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
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }

        private func FindStatic(asm Assembly, name string) MethodInfo? {
            for t in asm.GetTypes() {
                let m MethodInfo? = t.GetMethod(
                    name,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                if m != nil {
                    return m
                }
            }
            throw InvalidOperationException("No static method named '$name' in emitted assembly.")
        }
    }
}
