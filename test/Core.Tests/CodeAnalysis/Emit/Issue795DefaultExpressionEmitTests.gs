// <copyright file="Issue795DefaultExpressionEmitTests.cs" company="GSharp">
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

/// Issue #795 / ADR-0100: end-to-end emit tests that compile a G#
/// program using the new `default(T)` and bare `default`
/// expression forms, load the emitted assembly and run its entry point,
/// asserting on the captured stdout. These prove that the lowering pass
/// pre-allocates a slot for every value-type / type-parameter default
/// site and that the emitter produces verifiable IL
/// (`ldnull` for reference types; `ldloca; initobj T; ldloc`
/// for value types and unconstrained type parameters).
open class Issue795DefaultExpressionEmitTests {
    @Fact
    func Default_Int32_ReturnsZero() {
        const Source = `package main
import System
Console.WriteLine(default(int32))
`
        let lines = CompileAndRun(Source, "Issue795-Default-Int32")
        Assert.Equal("0", lines[0])
    }

    @Fact
    func Default_String_ReturnsNull() {
        const Source = `package main
import System
let s string = default(string)
Console.WriteLine(s == nil)
`
        let lines = CompileAndRun(Source, "Issue795-Default-String")
        Assert.Equal("True", lines[0])
    }

    @Fact
    func Default_Float64_ReturnsZero() {
        const Source = `package main
import System
Console.WriteLine(default(float64))
`
        let lines = CompileAndRun(Source, "Issue795-Default-Float")
        Assert.Equal("0", lines[0])
    }

    @Fact
    func Default_Bool_ReturnsFalse() {
        const Source = `package main
import System
Console.WriteLine(default(bool))
`
        let lines = CompileAndRun(Source, "Issue795-Default-Bool")
        Assert.Equal("False", lines[0])
    }

    @Fact
    func BareDefault_InTypedLet_Works() {
        const Source = `package main
import System
let x int32 = default
Console.WriteLine(x)
`
        let lines = CompileAndRun(Source, "Issue795-BareDefault-Let")
        Assert.Equal("0", lines[0])
    }

    @Fact
    func BareDefault_InReturn_Works() {
        const Source = `package main
import System
func zero() int32 {
    return default
}
Console.WriteLine(zero())
`
        let lines = CompileAndRun(Source, "Issue795-BareDefault-Return")
        Assert.Equal("0", lines[0])
    }

    @Fact
    func GenericDefault_OfUnconstrainedT_ForValueType_ReturnsZero() {
        // The interesting case from the issue: default(T) for an
        // unconstrained type parameter MUST emit `ldloca; initobj T;
        // ldloc` so the value-type case lights up at runtime with a
        // zero-initialised value.
        const Source = `package main
import System
func MakeZero[T]() T {
    return default(T)
}
Console.WriteLine(MakeZero[int32]())
`
        let lines = CompileAndRun(Source, "Issue795-GenericDefault-Value")
        Assert.Equal("0", lines[0])
    }

    @Fact
    func GenericDefault_OfUnconstrainedT_ForReferenceType_ReturnsNull() {
        const Source = `package main
import System
func MakeZero[T]() T {
    return default(T)
}
let s = MakeZero[string]()
Console.WriteLine(s == nil)
`
        let lines = CompileAndRun(Source, "Issue795-GenericDefault-Ref")
        Assert.Equal("True", lines[0])
    }

    @Fact
    func Default_NullableInt_ReturnsNull() {
        const Source = `package main
import System
let x int32? = default(int32?)
Console.WriteLine(x == nil)
`
        let lines = CompileAndRun(Source, "Issue795-Default-NullableInt")
        Assert.Equal("True", lines[0])
    }

    @Fact
    func BareDefault_InCallArgument_Works() {
        const Source = `package main
import System
func echo(x int32) int32 {
    return x
}
Console.WriteLine(echo(default))
`
        let lines = CompileAndRun(Source, "Issue795-BareDefault-CallArg")
        Assert.Equal("0", lines[0])
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
