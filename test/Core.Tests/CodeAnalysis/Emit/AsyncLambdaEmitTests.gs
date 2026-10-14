// <copyright file="AsyncLambdaEmitTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// End-to-end emit tests for async lambda (function literal) support.
/// Each test compiles GSharp source containing an async lambda, loads the
/// resulting PE, invokes the entry point, and asserts on console output.
/// Uses Task.Yield() to force genuine suspension/resume.
open class AsyncLambdaEmitTests {
    @Fact
    func AsyncLambda_NoCaptures_AwaitsTaskYield_Returns_Value() {
        const Source = `package AsyncLambdaTest1
import System
import System.Threading.Tasks

var f = async func() int32 {
    var x = 10
    await Task.Yield()
    x = x + 32
    return x
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncLambdaTest1")
        Assert.Contains("42", output)
    }

    @Fact
    func AsyncLambda_CapturesLocal_ReadsLatestValue_AcrossAwait() {
        const Source = `package AsyncLambdaTest2
import System
import System.Threading.Tasks

var x = 100
var f = async func() int32 {
    await Task.Yield()
    return x
}

x = 200
var t = f()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncLambdaTest2")
        // Issue #523: closures capture the variable cell (Go/C# semantics),
        // not its value at literal-evaluation time. Top-level `var x` is a
        // static field, so the async lambda reads the latest value (200).
        Assert.Contains("200", output)
    }

    @Fact
    func AsyncLambda_CapturesParameter_AwaitTaskYield_ReturnsParamPlusOne() {
        const Source = `package AsyncLambdaTest3
import System
import System.Threading.Tasks

var n = 41
var f = async func() int32 {
    await Task.Yield()
    return n + 1
}

var t = f()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncLambdaTest3")
        Assert.Contains("42", output)
    }

    @Fact
    func AsyncLambda_TwoLambdasInOneFunction_BothCompose() {
        const Source = `package AsyncLambdaTest4
import System
import System.Threading.Tasks

var a = 10
var b = 50

var f1 = async func() int32 {
    await Task.Yield()
    return a + 3
}

var f2 = async func() int32 {
    await Task.Yield()
    return b + 7
}

var t1 = f1()
var t2 = f2()
t1.Wait()
t2.Wait()
Console.WriteLine(t1.Result)
Console.WriteLine(t2.Result)
`
        let output = CompileAndRun(Source, "AsyncLambdaTest4")
        Assert.Contains("13", output)
        Assert.Contains("57", output)
    }

    @Fact
    func AsyncLambda_VoidReturn_AwaitsTaskYield() {
        const Source = `package AsyncLambdaTest5
import System
import System.Threading.Tasks

var f = async func() {
    Console.WriteLine("before")
    await Task.Yield()
    Console.WriteLine("after")
}

var t = f()
t.Wait()
`
        let output = CompileAndRun(Source, "AsyncLambdaTest5")
        Assert.Contains("before", output)
        Assert.Contains("after", output)
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
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
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
