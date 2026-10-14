// <copyright file="Issue669IfExpressionEmitTests.cs" company="GSharp">
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

/// Issue #669: end-to-end emit tests for if-expressions as value-producing
/// forms. Covers basic two-arm, else-if chains, nested if-expressions,
/// multi-statement blocks, if-expression as argument, and type inference.
open class Issue669IfExpressionEmitTests {
    @Fact
    func IfExpression_TrueArm_ReturnsCorrectValue() {
        const Source = `package IfExpr1
import System

var cond = true
var x = if cond { 11 } else { 22 }
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "IfExpr1")
        Assert.Contains("11", output)
    }

    @Fact
    func IfExpression_FalseArm_ReturnsCorrectValue() {
        const Source = `package IfExpr2
import System

var cond = false
var x = if cond { 11 } else { 22 }
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "IfExpr2")
        Assert.Contains("22", output)
    }

    @Fact
    func IfExpression_StringArms() {
        const Source = `package IfExprStr
import System

var pick = true
var label = if pick { "yes" } else { "no" }
Console.WriteLine(label)
`
        let output = CompileAndRun(Source, "IfExprStr")
        Assert.Contains("yes", output)
    }

    @Fact
    func IfExpression_ElseIfChain() {
        const Source = `package IfExprChain
import System

var score = 85
var grade = if score >= 90 { "A" } else if score >= 80 { "B" } else if score >= 70 { "C" } else { "F" }
Console.WriteLine(grade)
`
        let output = CompileAndRun(Source, "IfExprChain")
        Assert.Contains("B", output)
    }

    @Fact
    func IfExpression_ElseIfChain_LastArm() {
        const Source = `package IfExprChain2
import System

var score = 50
var grade = if score >= 90 { "A" } else if score >= 80 { "B" } else if score >= 70 { "C" } else { "F" }
Console.WriteLine(grade)
`
        let output = CompileAndRun(Source, "IfExprChain2")
        Assert.Contains("F", output)
    }

    @Fact
    func IfExpression_Nested() {
        const Source = `package IfExprNest
import System

var a = true
var b = false
var n = if a { if b { 1 } else { 2 } } else { 3 }
Console.WriteLine(n)
`
        let output = CompileAndRun(Source, "IfExprNest")
        Assert.Contains("2", output)
    }

    @Fact
    func IfExpression_MultiStatementBlock() {
        const Source = `package IfExprMulti
import System

var isAdmin = true
var title = if isAdmin {
    Console.Write("")
    "Admin"
} else { "Home" }
Console.WriteLine(title)
`
        let output = CompileAndRun(Source, "IfExprMulti")
        Assert.Contains("Admin", output)
    }

    @Fact
    func IfExpression_AsCallArgument() {
        const Source = `package IfExprArg
import System

var flag = true
Console.WriteLine(if flag { "on" } else { "off" })
`
        let output = CompileAndRun(Source, "IfExprArg")
        Assert.Contains("on", output)
    }

    @Fact
    func IfExpression_TypeInference() {
        const Source = `package IfExprInfer
import System

var x = 10
let result = if x > 5 { x * 2 } else { x + 1 }
Console.WriteLine(result)
`
        let output = CompileAndRun(Source, "IfExprInfer")
        Assert.Contains("20", output)
    }

    @Fact
    func IfExpression_MissingElse_ReportsGS0276() {
        const Source = `package IfExprNoElse

var cond = true
var x = if cond { 1 }
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0276")
    }

    @Fact
    func IfExpression_EmptyBlock_ReportsGS0277() {
        const Source = `package IfExprEmpty

var cond = true
var x = if cond { } else { 1 }
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0277")
    }

    @Fact
    func IfExpression_NoCommonType_ReportsGS0263() {
        const Source = `package IfExprBadType

var cond = true
var x = if cond { true } else { "no" }
`
        let diags = CompileExpectingDiagnostics(Source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0263")
    }

    @Fact
    func Ternary_StillWorks_AfterIfExpression() {
        // Regression guard: ternary continues to work
        const Source = `package TernaryStill
import System

var pick = true
var x = pick ? 11 : 22
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "TernaryStill")
        Assert.Contains("11", output)
    }

    @Fact
    func IfExpression_OriginalReproFromIssue() {
        // The original repro from issue #669 (adapted to compile):
        // `let f = if filter != nil { filter!! } else { LibraryFilter() }`
        const Source = `package IfExprRepro
import System

func LibraryFilter() string {
    return "default"
}

var filter string? = nil
let f = if filter != nil { filter!! } else { LibraryFilter() }
Console.WriteLine(f)
`
        let output = CompileAndRun(Source, "IfExprRepro")
        Assert.Contains("default", output)
    }

    @Fact
    func IfExpression_OriginalReproWithNonNilFilter() {
        const Source = `package IfExprRepro2
import System

func LibraryFilter() string {
    return "default"
}

var filter string? = "custom"
let f = if filter != nil { filter!! } else { LibraryFilter() }
Console.WriteLine(f)
`
        let output = CompileAndRun(Source, "IfExprRepro2")
        Assert.Contains("custom", output)
    }

    @Fact
    func IfStatement_StillWorks_Unchanged() {
        // Regression guard: if-statement unchanged
        const Source = `package IfStmt
import System

var x = 0
if true {
    x = 42
}
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "IfStmt")
        Assert.Contains("42", output)
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
