// <copyright file="DecimalPatternEmitTests.cs" company="GSharp">
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

/// Regression coverage for issue #421 (P2-3): constant patterns over the
/// `decimal` struct type must not emit `Ceq` (undefined on struct
/// operands per ECMA-335 §III.4). The emitter must route through
/// `decimal.op_Equality` so the produced IL is verifiable and the
/// runtime actually executes the comparison.
open class DecimalPatternEmitTests {
    @Fact
    func Switch_DecimalConstantPattern_Matches() {
        const Source = `package DecPatMatch
import System
let v = 1.5m
let x = switch v { case 1.5m: "hit" default: "miss" }
Console.WriteLine(x)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "Switch_DecimalConstantPattern_Matches")
        Assert.Contains("hit", output)
    }

    @Fact
    func Switch_DecimalConstantPattern_DoesNotMatch_FallsThroughToDefault() {
        const Source = `package DecPatMiss
import System
let v = 2.5m
let x = switch v { case 1.5m: "hit" default: "miss" }
Console.WriteLine(x)
`
        let output = CompileLoadInvokeCaptureStdout(
            Source,
            "Switch_DecimalConstantPattern_DoesNotMatch_FallsThroughToDefault"
        )
        Assert.Contains("miss", output)
    }

    @Fact
    func Switch_DecimalConstantPattern_PicksCorrectArmAmongMany() {
        const Source = `package DecPatMulti
import System
let v = 3.25m
let x = switch v {
    case 1.0m: "one"
    case 2.0m: "two"
    case 3.25m: "three-quarter"
    default: "other"
}
Console.WriteLine(x)
`
        let output = CompileLoadInvokeCaptureStdout(Source, "Switch_DecimalConstantPattern_PicksCorrectArmAmongMany")
        Assert.Contains("three-quarter", output)
    }

    shared {
        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
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
