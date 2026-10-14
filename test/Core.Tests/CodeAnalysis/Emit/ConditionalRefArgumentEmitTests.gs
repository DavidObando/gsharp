// <copyright file="ConditionalRefArgumentEmitTests.cs" company="GSharp">
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

/// ADR-0061: end-to-end emit and binder tests for conditional ref-argument
/// expressions of the form `f(ref cond ? a : b)`. Exercises all four
/// ref-kinds (`ref`/`out`/`in` + bare `&`), the
/// parenthesised `&(cond ? a : b)` form, inner-modifier matching,
/// and the bind-time validation diagnostics (branch type mismatch,
/// inline-decl-in-branch, inner-modifier mismatch, conditional-outside-ref).
open class ConditionalRefArgumentEmitTests {
    @Fact
    func RefConditional_SelectsTrueBranch_WhenConditionIsTrue() {
        const Source = `package CondRefTrue
import System

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 10
var b = 20
var useA = true
bump(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondRefTrue")
        Assert.Contains("11", output)
        Assert.Contains("20", output)
    }

    @Fact
    func RefConditional_SelectsFalseBranch_WhenConditionIsFalse() {
        const Source = `package CondRefFalse
import System

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 10
var b = 20
var useA = false
bump(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondRefFalse")
        Assert.Contains("10", output)
        Assert.Contains("21", output)
    }

    @Fact
    func RefConditional_InnerRefOnBranches_MatchesOuterRef() {
        const Source = `package CondRefInner
import System

func bump(ref counter int32) {
    counter = counter + 5
}

var a = 0
var b = 0
var useA = true
bump(ref useA ? ref a : ref b)
useA = false
bump(ref useA ? ref a : ref b)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondRefInner")
        Assert.Contains("5", output)
    }

    @Fact
    func OutConditional_AssignsSelectedBranch() {
        const Source = `package CondOut
import System

func setTo(out target int32, v int32) {
    target = v
}

var a = 0
var b = 0
var useA = false
setTo(out useA ? a : b, 42)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondOut")
        Assert.Contains("0", output)
        Assert.Contains("42", output)
    }

    @Fact
    func InConditional_ReadsSelectedBranch() {
        const Source = `package CondIn
import System

func readVia(in src int32) int32 {
    return src + 1
}

var a = 100
var b = 200
var useA = false
Console.WriteLine(readVia(in useA ? a : b))
`
        let output = CompileAndRun(Source, "CondIn")
        Assert.Contains("201", output)
    }

    @Fact
    func BareAmpersand_ParenthesizedConditional_ProducesPointer() {
        const Source = `package CondAmpParen
import System

func bump(ref counter int32) {
    counter = counter + 7
}

var a = 0
var b = 0
var useA = true
bump(&(useA ? a : b))
useA = false
bump(&(useA ? a : b))
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondAmpParen")
        Assert.Contains("7", output)
    }

    @Fact
    func RefConditional_OverImportedBclMethod_Interlocked() {
        const Source = `package CondInterlocked
import System
import System.Threading

var a = 0
var b = 0
var useA = true
Interlocked.Increment(ref useA ? a : b)
Console.WriteLine(a)
Console.WriteLine(b)
`
        let output = CompileAndRun(Source, "CondInterlocked")
        Assert.Contains("1", output)
        Assert.Contains("0", output)
    }

    @Fact
    func RefConditional_BranchTypeMismatch_ReportsDiagnostic() {
        const Source = `package CondTypeMismatch

func bump(ref counter int32) {
    counter = counter + 1
}

var a int32 = 0
var b int64 = 0
bump(ref true ? a : b)
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0260")
    }

    @Fact
    func RefConditional_NonLvalueBranch_ReportsDiagnostic() {
        const Source = `package CondNonLvalue

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 0
bump(ref true ? a : (a + 1))
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(
            diags,
            (d Diagnostic) -> d.Id == "GS9006" || d.Id == "GS0260" || d.Id == "GS0244" || d.Message.Contains(
                "Cannot take address",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    @Fact
    func RefConditional_InnerModifierMismatch_ReportsDiagnostic() {
        const Source = `package CondInnerMismatch

func bump(ref counter int32) {
    counter = counter + 1
}

var a = 0
var b = 0
bump(ref true ? in a : ref b)
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0262")
    }

    @Fact
    func OutConditional_InlineDeclInBranch_RejectedByParser() {
        // ADR-0061 §6: the inline-declaration `out var/let/_` form is not
        // syntactically reachable inside a conditional branch — the inner
        // modifier consumer only accepts `ref|in|out <identifier>`, never
        // `out var <ident>`. We assert that the program is rejected (the
        // exact diagnostic may be a parser error or GS0261).
        const Source = `package CondInlineDecl

func produce(out v int32) {
    v = 1
}

var a = 0
produce(out true ? a : out var n)
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.NotEmpty(diags)
    }

    @Fact
    func ConditionalRefArgument_OutsideRefContext_IsNowValidValueExpression() {
        // ADR-0062 supersedes GS0259: a `cond ? a : b` expression is now
        // legal in any expression position; both arms select an int value.
        const Source = `package CondOutsideRef
import System

var a = 1
var b = 2
var useA = true
var picked = (useA ? a : b)
Console.WriteLine(picked)
`
        let output = CompileAndRun(Source, "CondOutsideRef")
        Assert.Contains("1", output)
    }

    @Fact
    func RefConditional_ReadOnlyTarget_RejectedForRef() {
        const Source = `package CondRefReadOnly

func bump(ref counter int32) {
    counter = counter + 1
}

let a = 5
var b = 0
bump(ref true ? a : b)
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(
            diags,
            (d Diagnostic) -> d.Id == "GS9005" || d.Message.Contains("constant", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func InConditional_ReadOnlyTarget_Accepted() {
        const Source = `package CondInReadOnly
import System

func doubleIt(in v int32) int32 {
    return v + v
}

let a = 11
var b = 22
var useA = true
Console.WriteLine(doubleIt(in useA ? a : b))
`
        let output = CompileAndRun(Source, "CondInReadOnly")
        Assert.Contains("22", output)
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
