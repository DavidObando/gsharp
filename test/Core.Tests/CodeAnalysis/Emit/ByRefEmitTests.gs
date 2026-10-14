// <copyright file="ByRefEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// ADR-0039: End-to-end emit tests for by-ref pointer operations.
/// Compile GSharp source to PE, load, invoke, verify stdout/behavior.
open class ByRefEmitTests {
    @Fact
    func IntTryParse_Success_Emits_And_Runs() {
        const Source = `package TryParseSuccess
import System

var result = 0
var ok = Int32.TryParse("42", &result)
if ok {
    Console.WriteLine(result)
} else {
    Console.WriteLine("failed")
}
`
        let output = CompileAndRun(Source, "TryParseSuccess")
        Assert.Contains("42", output)
    }

    @Fact
    func IntTryParse_Failure_Emits_And_Runs() {
        const Source = `package TryParseFailure
import System

var result = 99
var ok = Int32.TryParse("nope", &result)
if ok {
    Console.WriteLine("should not happen")
} else {
    Console.WriteLine("correctly failed")
}
`
        let output = CompileAndRun(Source, "TryParseFailure")
        Assert.Contains("correctly failed", output)
    }

    @Fact
    func AddressOf_Local_Emits_Ldloca() {
        // Verifies that taking the address of a local and passing it to
        // a ref parameter works end-to-end through ldloca.
        const Source = `package LdlocaTest
import System
import System.Threading

var counter = 0
Interlocked.CompareExchange(&counter, 1, 0)
Console.WriteLine(counter)
`
        let output = CompileAndRun(Source, "LdlocaTest")
        Assert.Contains("1", output)
    }

    // ADR-0056 (#344) low-hanging-fruit #3: a `[]int32` argument flowing into a
    // `ReadOnlySpan[int32]` parameter goes through the `op_Implicit` conversion at
    // the call site, end-to-end, just like it already does at local-init position.
    @Fact
    func SliceArgument_ToReadOnlySpanParameter_Emits_And_Runs() {
        const Source = `package SliceToSpanArg
import System

func sum(s ReadOnlySpan[int32]) int32 {
    return s.Length
}

var nums []int32 = []int32{10, 20, 30}
Console.WriteLine(sum(nums))
`
        let output = CompileAndRun(Source, "SliceToSpanArg")
        Assert.Contains("3", output)
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
