// <copyright file="Issue2023CheckedUnaryNegationEmitTests.cs" company="GSharp">
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

/// Issue #2023: follow-up to #1881 — unary negation (`-x`) did not honor
/// a `checked` context at all: the emitter always emitted the plain
/// `neg` opcode (2's-complement negation, which silently wraps
/// `MinValue` back to itself) regardless of context. These tests
/// exercise the compiled (emit) backend;
/// (cref:GSharp.Core.Tests.CodeAnalysis.Binding.Issue2023CheckedUnaryNegationEmittedOracleTests)
/// pins additional forms through the emitted submission oracle.
open class Issue2023CheckedUnaryNegationEmitTests {
    @Fact
    func CheckedNegation_Int32MinValue_Throws() {
        const Source = `package Issue2023Int32
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var caught = "no"
    try {
        var boom = checked(-minInt)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Int32")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedNegation_Int64MinValue_Throws() {
        const Source = `package Issue2023Int64
import System

func run() {
    var minLong int64 = -9223372036854775807 - 1
    var caught = "no"
    try {
        var boom = checked(-minLong)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Int64")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedNegation_Int8MinValue_Throws() {
        const Source = `package Issue2023Int8
import System

func run() {
    var minI8 int8 = -128
    var caught = "no"
    try {
        var boom = checked(-minI8)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Int8")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedNegation_Int16MinValue_Throws() {
        const Source = `package Issue2023Int16
import System

func run() {
    var minI16 int16 = -32768
    var caught = "no"
    try {
        var boom = checked(-minI16)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = "yes"
    }
    Console.WriteLine(caught)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Int16")
        Assert.Contains("yes", output)
    }

    @Fact
    func CheckedNegation_OrdinaryValue_ReturnsNegated() {
        const Source = `package Issue2023Ordinary
import System

func run() {
    var five int32 = 5
    var negated = checked(-five)
    Console.WriteLine(negated)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Ordinary")
        Assert.Contains("-5", output)
    }

    @Fact
    func UncheckedNegation_Int32MinValue_Wraps() {
        const Source = `package Issue2023Unchecked
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var wrapped = unchecked(-minInt)
    Console.WriteLine(wrapped)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Unchecked")
        Assert.Contains("-2147483648", output)
    }

    @Fact
    func DefaultContext_NegationOfInt32MinValue_Wraps() {
        // Issue #1881 established unchecked as the project default when no
        // explicit checked/unchecked context is in scope; negation must match.
        const Source = `package Issue2023Default
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var wrapped = -minInt
    Console.WriteLine(wrapped)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Default")
        Assert.Contains("-2147483648", output)
    }

    @Fact
    func CheckedNegation_Float64_NoOverflowEverOccurs() {
        const Source = `package Issue2023Float
import System

func run() {
    var big float64 = -1.7976931348623157e308
    var negated = checked(-big)
    Console.WriteLine(negated)
}

run()
`
        let output = CompileAndRun(Source, "Issue2023Float")
        Assert.Contains("1.7976931348623157E+308", output)
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
