// <copyright file="RefLocalAliasingEmitTests.cs" company="GSharp">
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

/// Issue #491 (ADR-0060 follow-up): end-to-end emit tests for ref-aliasing locals
/// declared with `let ref` / `var ref`. The IL slot for a ref-aliasing
/// local is a managed pointer `T&`: reads emit `ldloc; ldind.*`, writes
/// emit `ldloc; value; stind.*`, and `&m` emits `ldloc` (the slot
/// is already the alias).
open class RefLocalAliasingEmitTests {
    @Fact
    func LetRef_WriteThroughAlias_UpdatesUnderlyingVariable() {
        const Source = `package LetRefArr
import System

func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[1]
    m = 99
    Console.WriteLine(arr[1])
}

tweak()
`
        let output = CompileAndRun(Source, "LetRefArr")
        Assert.Contains("99", output)
    }

    @Fact
    func LetRef_AliasPassedAsRefArg_BumpsUnderlying() {
        const Source = `package LetRefPass
import System

func bump(ref slot int32) {
    slot = slot + 1
}

func tweak() {
    var n int32 = 41
    let ref m = n
    bump(&m)
    Console.WriteLine(n)
}

tweak()
`
        let output = CompileAndRun(Source, "LetRefPass")
        Assert.Contains("42", output)
    }

    @Fact
    func VarRef_AliasStructField_WritesThroughAlias() {
        const Source = `package VarRefField
import System

struct Counter {
    var Value int32
}

func tweak() {
    var c Counter = Counter{Value: 5}
    var ref v = c.Value
    v = v + 100
    Console.WriteLine(c.Value)
}

tweak()
`
        let output = CompileAndRun(Source, "VarRefField")
        Assert.Contains("105", output)
    }

    @Fact
    func LetRef_ReadThroughAliasAndAssignmentExpression_ReturnsValue() {
        // Issue #491: the spill-collector / value-spill path produces correct
        // assignment-as-expression results for ref locals (parity with ref params).
        const Source = `package LetRefAssignExpr
import System

func tweak() {
    var n int32 = 0
    let ref m = n
    let r = (m = 17)
    Console.WriteLine(r)
    Console.WriteLine(n)
}

tweak()
`
        let output = CompileAndRun(Source, "LetRefAssignExpr")
        Assert.Contains("17", output)
    }

    @Fact
    func LetRef_FromEndIndex_WritesThroughAlias() {
        // Issue #3247: `let ref m = arr[^1]` — the from-end lowering spills
        // the receiver and offset into temps; the alias then takes the element
        // address (ldelema) once the prefix has run.
        const Source = `package LetRefFromEnd
import System

func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[^1]
    m = 99
    Console.WriteLine("${arr[0]},${arr[1]},${arr[2]}")
}

tweak()
`
        let output = CompileAndRun(Source, "LetRefFromEnd")
        Assert.Contains("10,20,99", output)
    }

    @Fact
    func LetRef_FromEndNonConstantOffset_CapturesElementAtDeclaration() {
        // Issue #3247: `^expr` with a non-constant offset — the offset is
        // evaluated once at the declaration; later mutation of the offset
        // variable must not re-target the alias.
        const Source = `package LetRefFromEndVar
import System

func tweak() {
    var arr = []int32{10, 20, 30}
    var k int32 = 2
    let ref m = arr[^k]
    k = 1
    m = 77
    Console.WriteLine("${arr[0]},${arr[1]},${arr[2]}")
}

tweak()
`
        let output = CompileAndRun(Source, "LetRefFromEndVar")
        Assert.Contains("10,77,30", output)
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
