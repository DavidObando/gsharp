// <copyright file="ConditionalExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// ADR-0062: end-to-end emit and binder tests for the generalized two-arm
/// conditional (ternary) expression `cond ? a : b` in value context.
/// Byref/lvalue ref-arg ternaries continue to be covered by
/// (cref:ConditionalRefArgumentEmitTests).
open class ConditionalExpressionTests {
    @Fact
    func Ternary_ValueContext_TrueArmSelected() {
        const Source = `package CondTern1
import System

var pick = true
var x = pick ? 11 : 22
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "CondTern1")
        Assert.Contains("11", output)
    }

    @Fact
    func Ternary_ValueContext_FalseArmSelected() {
        const Source = `package CondTern2
import System

var pick = false
var x = pick ? 11 : 22
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "CondTern2")
        Assert.Contains("22", output)
    }

    @Fact
    func Ternary_StringArms() {
        const Source = `package CondTernStr
import System

var pick = true
Console.WriteLine(pick ? "yes" : "no")
`
        let output = CompileAndRun(Source, "CondTernStr")
        Assert.Contains("yes", output)
    }

    @Fact
    func Ternary_NumericTieBreak_PicksWiderType() {
        // int32 + int64 => int64 via the numeric tie-break.
        const Source = `package CondTernWiden
import System

var pick = true
var a int32 = 1
var b int64 = 2
var c = pick ? a : b
Console.WriteLine(c)
`
        let output = CompileAndRun(Source, "CondTernWiden")
        Assert.Contains("1", output)
    }

    @Fact
    func Ternary_RightAssociative_NestedFalseBranch() {
        // `a ? b : c ? d : e` parses as `a ? b : (c ? d : e)`.
        const Source = `package CondTernNest
import System

var a = false
var c = false
var v = a ? 1 : (c ? 2 : 3)
Console.WriteLine(v)
`
        let output = CompileAndRun(Source, "CondTernNest")
        Assert.Contains("3", output)
    }

    @Fact
    func Ternary_AsCallArgument() {
        const Source = `package CondTernArg
import System

var pick = true
Console.WriteLine(pick ? 10 : 20)
`
        let output = CompileAndRun(Source, "CondTernArg")
        Assert.Contains("10", output)
    }

    @Fact
    func Ternary_NoCommonType_ReportsGS0263() {
        // bool and string have no common type.
        const Source = `package CondTernNoCommon

var pick = true
var v = pick ? true : "no"
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func Ternary_NonBoolCondition_Reports() {
        const Source = `package CondTernBadCond

var v = 1 ? 2 : 3
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.NotEmpty(diags)
    }

    @Fact
    func Ternary_InRefArgContext_StillUsesAddressPath() {
        // ADR-0062 §3: the generalized ternary in a ref-arg payload is
        // bound to the conditional-address path, preserving ADR-0061.
        const Source = `package CondTernRef
import System

func bump(ref c int32) {
    c = c + 1
}

var a = 0
var b = 0
var pick = true
bump(ref pick ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondTernRef")
        Assert.Contains("1", output)
        Assert.Contains("0", output)
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

        private func CompileExpectingDiagnostics(source string) IReadOnlyList[Diagnostic] {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.False(
                result.Success,
                "compilation was expected to fail: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Id + ":" + d.Message)
                )
            )
            return result.Diagnostics
        }
    }
}
