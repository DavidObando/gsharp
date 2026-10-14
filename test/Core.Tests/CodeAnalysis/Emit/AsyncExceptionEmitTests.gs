// <copyright file="AsyncExceptionEmitTests.cs" company="GSharp">
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

/// End-to-end PE round-trip tests for the async exception handler rewriter.
/// Verifies that try/catch/finally with await compile and produce correct results.
open class AsyncExceptionEmitTests {
    @Fact
    func AsyncFunction_With_TryFinally_NoAwait_Runs() {
        const Source = `package AsyncExhNoAwait
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        result = 42
    } finally {
        result = result + 1
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncExhNoAwait")
        Assert.Contains("43", output)
    }

    @Fact
    func AsyncFunction_With_AwaitInFinally_RunsFinallyAfterTry() {
        const Source = `package AsyncExhAwaitFinally
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        result = 10
    } finally {
        let extra = await Task.FromResult(32)
        result = result + extra
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncExhAwaitFinally")
        Assert.Contains("42", output)
    }

    @Fact
    func AsyncFunction_With_TryCatch_AwaitInCatch_HandlesException() {
        const Source = `package AsyncExhAwaitCatch
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse("bad")
        result = n
    } catch (e Exception) {
        let fallback = await Task.FromResult(42)
        result = fallback
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncExhAwaitCatch")
        Assert.Contains("42", output)
    }

    @Fact
    func AsyncFunction_With_TryFinally_AwaitInFinally_PropagatesException() {
        // Verifies that an exception from the try body propagates through
        // the rewritten finally (Pattern B) after the finally body executes.
        // Note: We avoid nesting inside another try/catch because the state
        // machine emitter does not yet support await inside nested try blocks
        // (the suspension br illegally crosses try boundaries).
        const Source = `package AsyncExhPropagates
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse("bad")
        result = n
    } finally {
        let extra = await Task.FromResult(1)
        result = result + extra
    }
    return result
}

var t = run()
try {
    t.Wait()
} catch (e Exception) {
}
Console.WriteLine(t.IsFaulted)
`
        let output = CompileAndRun(Source, "AsyncExhPropagates")
        Assert.Contains("True", output)
    }

    @Fact
    func AsyncFunction_NoException_AwaitInFinally_DoesNotThrow() {
        const Source = `package AsyncExhNoThrow
import System
import System.Threading.Tasks

async func run() int32 {
    var result = 10
    try {
        result = result + 20
    } finally {
        let bonus = await Task.FromResult(12)
        result = result + bonus
    }
    return result
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncExhNoThrow")
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
                } catch (tie TargetInvocationException) {
                    Console.SetOut(stdout)
                    throw Exception(
                        "Entry point threw: ${tie.InnerException?.GetType().Name}: ${tie.InnerException?.Message}",
                        tie.InnerException
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
