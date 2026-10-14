// <copyright file="Issue2544LiftedUnaryOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

open class Issue2544LiftedUnaryOperatorTests {
    @Fact
    func LiftedUnaryOperators_ValueEchoMatchesNullableSemantics() {
        // Historically the interpreter twin of this file's emit tests; runs
        // through the emitted oracle since the tree-walking evaluator retired
        // (ADR-0156 Phase 3c, #3176). Same sources, same expected values.
        Assert.Equal(true, Evaluate("var value bool? = nil${Environment.NewLine}(!value) ?? true"))
        Assert.Equal(false, Evaluate("var value bool? = true${Environment.NewLine}(!value) ?? true"))
        Assert.Equal(-5, Evaluate("var value int32? = 5${Environment.NewLine}(-value) ?? 0"))
    }

    @Fact
    func LiftedUnaryOperators_PropagateNilAndOperateOnPresentValues() {
        const Source = `package Issue2544
import System

var yes bool? = true
var noBool bool? = nil
Console.WriteLine((!yes) ?? true)
Console.WriteLine((!noBool) ?? false)

var five int32? = 5
var noInt int32? = nil
Console.WriteLine((-five) ?? 42)
Console.WriteLine((-noInt) ?? 42)
Console.WriteLine((~five) ?? 0)
Console.WriteLine((+five) ?? 0)`
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}-5${Environment.NewLine}42${Environment.NewLine}-6${Environment.NewLine}5${Environment.NewLine}",
            CompileAndRun(Source)
        )
    }

    @Theory
    @InlineData("+", "bool?")
    @InlineData("!", "int32?")
    @InlineData("-", "uint32?")
    func InvalidUnderlyingUnaryOperation_StillReportsGS0128(op string, type string) {
        let source = (`package Invalid
var value ` + "$type" + ` = nil
var bad = ` + "$op" + `value
`)
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0128")
    }

    shared {
        private func CompileAndRun(source string) string {
            using let peStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext("Issue2544", isCollectible: true)
            try {
                let assembly = loadContext.LoadFromStream(peStream)
                let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let entry MethodInfo? = program.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let previous = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
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
                    Console.SetOut(previous)
                }
                return output.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                loadContext.Unload()
            }
        }

        private func Evaluate(source string) object? {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Value
        }
    }
}
