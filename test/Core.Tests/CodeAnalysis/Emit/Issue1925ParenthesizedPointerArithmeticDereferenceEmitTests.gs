// <copyright file="Issue1925ParenthesizedPointerArithmeticDereferenceEmitTests.cs" company="GSharp">
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

/// Issue #1925: dereferencing a parenthesized pointer-arithmetic expression
/// (`*(p + i)`) misbound. The root cause lived in
/// `BindDereferenceExpression`'s `*T(expr)`-cast recognition (issue
/// #1014): it fired on ANY operand that bound to a `BoundConversionExpression`,
/// not just the actual `* IDENT ( expr )` cast syntax. Pointer arithmetic
/// (`p + i`) lowers to a `BoundConversionExpression` back to the
/// pointer type (see `LowerPointerOffset`), so `*(p + i)` tripped the
/// same branch and was rewrapped as a cast to a pointer-to-pointer, producing
/// `**int32` instead of `int32` — surfacing as
/// `GS0129: Binary operator '+=' is not defined for types 'int32' and
/// '**int32'` in `sum += *(p + i)`. Separately, the parser had no
/// support at all for a compound assignment (`+=`, `-=`, `*=`, …)
/// whose target is a pointer dereference (`*(p + i) += 1`); this test also
/// covers the new `IndirectCompoundAssignmentExpressionSyntax` desugaring
/// added to close that gap for ANY compound operator.
open class Issue1925ParenthesizedPointerArithmeticDereferenceEmitTests {
    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentRhs_ReadsPointeeValue() {
        // The exact repro from the grid app G12 fixture comment: `sum += *(p + i)`
        // used to fail GS0129 with the RHS misbound as `**int32`.
        const Source = `package Issue1925Sum
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var i int32 = 0
    var sum int32 = 0
    for i = 0; i < arr.Length; i += 1 {
        sum += *(p + i)
    }
    Console.WriteLine(sum)
}

run()
`
        let output = CompileAndRun(Source, "Issue1925Sum")
        Assert.Contains("26", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsPlainRead_YieldsPointeeType() {
        const Source = `package Issue1925Read
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    let x int32 = *(p + 2)
    Console.WriteLine(x)
}

run()
`
        let output = CompileAndRun(Source, "Issue1925Read")
        Assert.Contains("7", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsPlainAssignmentTarget_WritesThroughPointer() {
        const Source = `package Issue1925PlainAssign
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 0) = 42
    Console.WriteLine(arr[0])
}

run()
`
        let output = CompileAndRun(Source, "Issue1925PlainAssign")
        Assert.Contains("42", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_PlusEquals_WritesThroughPointer() {
        // The `*(p + i) += 1` shape named directly in the issue title/body.
        const Source = `package Issue1925PlusEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    var i int32 = 1
    *(p + i) += 100
    Console.WriteLine(arr[1])
}

run()
`
        let output = CompileAndRun(Source, "Issue1925PlusEquals")
        Assert.Contains("105", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_MinusEquals_WritesThroughPointer() {
        const Source = `package Issue1925MinusEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 2) -= 2
    Console.WriteLine(arr[2])
}

run()
`
        let output = CompileAndRun(Source, "Issue1925MinusEquals")
        Assert.Contains("5", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_AsCompoundAssignmentTarget_TimesEquals_WritesThroughPointer() {
        // Any compound operator must work generally, not just `+=`/`-=`.
        const Source = `package Issue1925TimesEquals
import System

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + 3) *= 3
    Console.WriteLine(arr[3])
}

run()
`
        let output = CompileAndRun(Source, "Issue1925TimesEquals")
        Assert.Contains("33", output)
    }

    @Fact
    func DereferenceOfParenthesizedPointerArithmetic_CompoundAssignmentTarget_EvaluatesPointerExpressionOnce() {
        // The pointer expression (here `p + next()`) must be evaluated exactly
        // once by the compound-assignment desugaring, mirroring the
        // single-evaluation guarantee `CompoundIndexAssignmentExpressionSyntax`
        // gives an indexer receiver.
        const Source = `package Issue1925SingleEval
import System

var callCount int32 = 0

func next() int32 {
    callCount += 1
    return 1
}

unsafe func run() {
    var arr = []int32{3, 5, 7, 11}
    var p *int32 = &arr[0]
    *(p + next()) += 100
    Console.WriteLine(arr[1])
    Console.WriteLine(callCount)
}

run()
`
        let output = CompileAndRun(Source, "Issue1925SingleEval")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Contains("105", lines)
        Assert.Contains("1", lines)
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
    }
}
