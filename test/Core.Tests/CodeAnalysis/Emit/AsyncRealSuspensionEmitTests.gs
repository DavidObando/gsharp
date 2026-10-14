// <copyright file="AsyncRealSuspensionEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests that exercise real async suspension and resume
/// through the threadpool. Unlike fast-path tests (Task.FromResult), these
/// tests use `Task.Yield()` and `Task.Delay()` to force the state
/// machine to suspend and resume via AwaitOnCompleted/AwaitUnsafeOnCompleted.
open class AsyncRealSuspensionEmitTests {
    @Fact
    func Await_TaskYield_ActuallySuspendsAndResumes() {
        const Source = `package YieldTest
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine("before")
    await Task.Yield()
    Console.WriteLine("after")
}

run().Wait()
`
        let output = CompileAndRun(Source, "YieldTest")
        Assert.Contains("before", output)
        Assert.Contains("after", output)
    }

    @Fact
    func Await_TaskYield_ResumesOnThreadpool() {
        const Source = `package YieldThreadTest
import System
import System.Threading
import System.Threading.Tasks

async func run() {
    var before = Thread.CurrentThread.ManagedThreadId
    await Task.Yield()
    var after = Thread.CurrentThread.ManagedThreadId
    Console.WriteLine(before)
    Console.WriteLine(after)
    Console.WriteLine("done")
}

var t = run()
t.Wait()
`
        let output = CompileAndRun(Source, "YieldThreadTest")
        Assert.Contains("done", output)
    }

    @Fact
    func Await_TaskDelay_Short_ResumesAndReturns() {
        const Source = `package DelayTest
import System
import System.Threading.Tasks

async func run() {
    Console.WriteLine("start")
    await Task.Delay(1)
    Console.WriteLine("end")
}

var t = run()
t.Wait()
`
        let output = CompileAndRun(Source, "DelayTest")
        Assert.Contains("start", output)
        Assert.Contains("end", output)
    }

    @Fact
    func Await_TaskYield_Twice_RestoresState() {
        const Source = `package YieldTwiceTest
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    await Task.Yield()
    x = x + 20
    await Task.Yield()
    x = x + 12
    return x
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "YieldTwiceTest")
        Assert.Contains("42", output)
    }

    @Fact
    func Await_ValueTask_FromResult_Returns_Value() {
        const Source = `package ValueTaskTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    let x = await ValueTask.FromResult(42)
    return x
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "ValueTaskTest")
        Assert.Contains("42", output)
    }

    @Fact
    func Await_TaskYield_In_Loop_RestoresState() {
        const Source = `package YieldLoopTest
import System
import System.Threading.Tasks

async func run() int32 {
    var sum = 0
    for var i = 0; i < 3; i++ {
        await Task.Yield()
        sum = sum + 10
    }
    return sum
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "YieldLoopTest")
        Assert.Contains("30", output)
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
                    // Unwrap Wait() exceptions.
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
