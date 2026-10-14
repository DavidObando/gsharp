// <copyright file="AsyncRefLocalEmitTests.cs" company="GSharp">
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

/// End-to-end PE round-trip tests for ref locals in async state machines.
/// Verifies that ref locals across await boundaries compile and produce correct results.
open class AsyncRefLocalEmitTests {
    @Fact
    func RefLocal_To_Local_Across_Await_ReadsCurrentValue() {
        // Declares a ref local pointing to a local, awaits, then writes to the
        // original local and reads through the (conceptual) ref local.
        const Source = `package AsyncRefLocal1
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    var slot = &x
    let added = await Task.FromResult(32)
    x = added + 10
    return *slot
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefLocal1")
        Assert.Contains("42", output)
    }

    @Fact
    func RefLocal_To_ArrayElement_Across_Await_RoundTrips() {
        // Declares a ref local pointing to an array element, awaits, then
        // reads through the ref local to verify the element value.
        const Source = `package AsyncRefArr
import System
import System.Threading.Tasks

async func run() int32 {
    var arr = [3]int32{10, 20, 30}
    var i = 1
    var slot = &arr[i]
    let delta = await Task.FromResult(22)
    return *slot + delta
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefArr")
        Assert.Contains("42", output)
    }

    @Fact
    func RefLocal_Used_Only_Before_Await_DoesNotRequireHoisting() {
        // The ref local is only used before the await — still must produce valid IL.
        const Source = `package AsyncRefBeforeAwait
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 40
    var slot = &x
    var before = *slot
    let extra = await Task.FromResult(2)
    return before + extra
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefBeforeAwait")
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
    }
}
