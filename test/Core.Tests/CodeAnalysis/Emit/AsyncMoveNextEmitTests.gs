// <copyright file="AsyncMoveNextEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for the async MoveNext per-await dispatch pipeline.
/// Each test compiles a GSharp source containing one or more `await` expressions
/// at statement top-level, loads the resulting PE, runs it, and asserts the
/// captured stdout. Awaits that resolve synchronously exercise the fast path
/// (no real suspension); `Task.Yield` exercises the suspend/resume path through
/// AwaitOnCompleted.
open class AsyncMoveNextEmitTests {
    @Fact
    func Await_CompletedTask_AsStatement_Runs() {
        const Source = `package AwaitCompletedTest
import System
import System.Threading.Tasks

async func doIt() {
    await Task.CompletedTask
    Console.WriteLine("after")
}

doIt().Wait()
Console.WriteLine("done")
`
        let output = CompileAndRun(Source, "AwaitCompletedTest")
        Assert.Contains("after", output)
        Assert.Contains("done", output)
    }

    @Fact
    func Await_TaskFromResult_ReturnValue_Funnels_Through_SetResult() {
        const Source = `package AwaitFromResultTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    let x = await Task.FromResult(42)
    return x
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AwaitFromResultTest")
        Assert.Contains("42", output)
    }

    @Fact
    func Await_TwoSequentialAwaits_BothRun() {
        const Source = `package TwoAwaitsTest
import System
import System.Threading.Tasks

async func doIt() int32 {
    let a = await Task.FromResult(10)
    let b = await Task.FromResult(32)
    return a + b
}

var t = doIt()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "TwoAwaitsTest")
        Assert.Contains("42", output)
    }

    @Fact
    func Await_Inside_InterpolationHole_Emits_And_Runs() {
        // Issue #368: an `await` inside an interpolation hole. The hole value is
        // pre-evaluated into a temp before the (ByRefLike) DefaultInterpolated-
        // StringHandler is constructed, so no handler local is live across the
        // suspension; the spiller then flattens the lowered block expression.
        const Source = `package AwaitInHoleTest
import System
import System.Threading.Tasks

async func getN() int32 {
    return await Task.FromResult(42)
}

async func build() string {
    return "n=${await getN()}"
}

var t = build()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AwaitInHoleTest")
        Assert.Contains("n=42", output)
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
