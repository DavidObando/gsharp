// <copyright file="SpanEmitTests.cs" company="GSharp">
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

/// ADR-0056 §1/§2: end-to-end emit tests for span element access. A span
/// indexer returns `ref readonly T` / `ref T`; reading
/// auto-dereferences (get_Item + ldobj/ldind), and a `Span[T]` write stores
/// through the returned managed pointer (get_Item + stobj/stind). Source is
/// compiled to a PE, loaded, invoked, and its stdout verified.
open class SpanEmitTests {
    @Fact
    func ReadOnlySpanElement_Read_Emits_And_Runs() {
        const Source = `package SpanReadEmit
import System

func sum(values []int32) int32 {
    var s ReadOnlySpan[int32] = values
    var total = 0
    var i = 0
    for i < s.Length {
        total = total + s[i]
        i = i + 1
    }
    return total
}

Console.WriteLine(sum([]int32{10, 20, 30}))
`
        let output = CompileAndRun(Source, "SpanReadEmit")
        Assert.Equal("60", output.Trim())
    }

    @Fact
    func SpanElement_Write_Emits_And_Runs() {
        const Source = `package SpanWriteEmit
import System

func writeBack(values []int32) int32 {
    var s Span[int32] = values
    s[0] = 100
    s[2] = 300
    return s[0] + s[1] + s[2]
}

Console.WriteLine(writeBack([]int32{1, 2, 3}))
`
        let output = CompileAndRun(Source, "SpanWriteEmit")
        Assert.Equal("402", output.Trim())
    }

    @Fact
    func SpanElement_WriteThenRead_RoundTrips() {
        const Source = `package SpanRoundTrip
import System

func roundTrip(values []int32) int32 {
    var s Span[int32] = values
    s[1] = 7
    return s[1]
}

Console.WriteLine(roundTrip([]int32{1, 2, 3}))
`
        let output = CompileAndRun(Source, "SpanRoundTrip")
        Assert.Equal("7", output.Trim())
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
