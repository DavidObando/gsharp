// <copyright file="Issue1279ArrayIndexTypesEmitTests.cs" company="GSharp">
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

/// Issue #1279: array/slice element access accepts any integer-typed index.
/// The narrower types convert to int32 and the wider integer types
/// (uint32/int64/uint64/nint/nuint) convert to native int — both valid CIL
/// ldelem/stelem index operands. These tests verify the correct element is
/// read and written at runtime for every supported index type.
open class Issue1279ArrayIndexTypesEmitTests {
    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("char")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func ArrayRead_WithIntegerIndex_ReadsCorrectElement(indexType string) {
        // a[2] == 30, indexed via a value of `indexType`.
        let source = (`package main
import System
var a = []int32{10, 20, 30, 40}
var i = ` + "$indexType" + `(2)
Console.WriteLine(a[i])
`)
        let lines = CompileAndRun(source, "Issue1279-Read-" + indexType)
        Assert.Equal("30", lines[0])
    }

    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("char")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func ArrayWrite_WithIntegerIndex_WritesCorrectElement(indexType string) {
        // a[3] = 99 via a `indexType` index, then read it back.
        let source = (`package main
import System
var a = []int32{0, 0, 0, 0}
var i = ` + "$indexType" + `(3)
a[i] = 99
Console.WriteLine(a[3])
`)
        let lines = CompileAndRun(source, "Issue1279-Write-" + indexType)
        Assert.Equal("99", lines[0])
    }

    @Fact
    func ArrayCompoundAssignment_WithWideIndex_Works() {
        let source = `package main
import System
var a = []int32{1, 2, 3, 4}
var i = int64(1)
a[i] += 40
Console.WriteLine(a[1])
`
        let lines = CompileAndRun(source, "Issue1279-Compound")
        Assert.Equal("42", lines[0])
    }

    shared {
        private func CompileAndRun(source string, contextName string)[]string {
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
                return captured
                    .ToString()
                    .ReplaceLineEndings(Environment.NewLine)
                    .TrimEnd(Environment.NewLine.ToCharArray())
                    .Split(Environment.NewLine)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
