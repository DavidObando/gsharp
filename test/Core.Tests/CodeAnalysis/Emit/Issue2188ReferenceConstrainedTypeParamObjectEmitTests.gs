// <copyright file="Issue2188ReferenceConstrainedTypeParamObjectEmitTests.cs" company="GSharp">
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

/// Issue #2188 (emit): storing a reference-constrained `T?` into an
/// `object?` slot and comparing the two with `==` / `!=` must JIT
/// and run with reference-identity semantics. The emitted body boxes the open
/// type-parameter operand (`box !!T`, a no-op for a reference `T`) and
/// compares with `ceq`; before the fix these forms failed to bind (GS0155 /
/// GS0129), and a naive lowering would have produced ilverify-rejected IL
/// comparing an opaque VAR/MVAR slot against a managed reference.
open class Issue2188ReferenceConstrainedTypeParamObjectEmitTests {
    @Fact
    func NullableClassTypeParam_StoredInObjectAndCompared_JitsAndRuns() {
        const Source = `package Issue2188Run
import System

class Animal { init() {} }

func RoundTrips[T class init()](v T?) bool {
    var box object? = v
    var same = box == v
    var diff = box != v
    return same && !diff
}

func DiffersFromOther[T class init()](v T?, other object?) bool -> other != v

var a = Animal()
Console.WriteLine(RoundTrips[Animal](a))
Console.WriteLine(RoundTrips[Animal](nil))
Console.WriteLine(DiffersFromOther[Animal](a, Animal()))
Console.WriteLine(DiffersFromOther[Animal](a, a))
`
        let lines = CompileLoadInvokeCaptureStdout(
            Source,
            "NullableClassTypeParam_StoredInObjectAndCompared_JitsAndRuns"
        )
            .ReplaceLineEndings(Environment.NewLine)
            .Trim()
            .Split(Environment.NewLine)
        Assert.Equal("True", lines[0].Trim()) // reference stored in object? equals itself
        Assert.Equal("True", lines[1].Trim()) // nil stored in object? equals nil
        Assert.Equal("True", lines[2].Trim()) // distinct instance differs
        Assert.Equal("False", lines[3].Trim()) // same instance does not differ

    }

    @Fact
    func NullableClassTypeParam_EmitsBoxAndCeqNoInvalidProgram() {
        // The emitted comparison must contain a `box` (for the type-parameter
        // operand) and must JIT — the reflection invoke below throws
        // InvalidProgramException on malformed IL.
        const Source = `package Issue2188Emit
import System

func Eq[T class](v T?, o object?) bool -> o == v

Console.WriteLine(Eq[string]("x", "x"))
Console.WriteLine(Eq[string]("x", "y"))
`
        let lines = CompileLoadInvokeCaptureStdout(Source, "NullableClassTypeParam_EmitsBoxAndCeqNoInvalidProgram")
            .ReplaceLineEndings(Environment.NewLine)
            .Trim()
            .Split(Environment.NewLine)
        Assert.Equal("True", lines[0].Trim())
        Assert.Equal("False", lines[1].Trim())
    }

    @Fact
    func UserDefinedEqualityOperatorOnClass_StillTakesPrecedence() {
        // Regression guard: a reference type with a user-declared `operator ==`
        // must keep using VALUE semantics — the #2188 reference-equality
        // fallback must NOT preempt it.
        const Source = `package Issue2188UserOp
import System

class Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator ==(b Vector2) bool -> a.X == b.X && a.Y == b.Y
func (a Vector2) operator !=(b Vector2) bool -> a.X != b.X || a.Y != b.Y

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 1, Y: 2}
Console.WriteLine(p == q)
Console.WriteLine(p != q)
`
        let lines = CompileLoadInvokeCaptureStdout(Source, "UserDefinedEqualityOperatorOnClass_StillTakesPrecedence")
            .ReplaceLineEndings(Environment.NewLine)
            .Trim()
            .Split(Environment.NewLine)
        // Distinct instances with equal fields: user `==` returns True (value
        // equality); a reference-identity fallback would have returned False.
        Assert.Equal("True", lines[0].Trim())
        Assert.Equal("False", lines[1].Trim())
    }

    shared {
        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
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
                let originalOut = Console.Out
                using let captured = StringWriter()
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
                    Console.SetOut(originalOut)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
