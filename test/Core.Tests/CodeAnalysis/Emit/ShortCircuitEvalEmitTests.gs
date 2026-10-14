// <copyright file="ShortCircuitEvalEmitTests.cs" company="GSharp">
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

/// Regression tests for issue #419 (P0-1): the logical operators `&&`
/// and `||` must short-circuit — the right operand must NOT be evaluated when
/// the left operand already determines the result.
open class ShortCircuitEvalEmitTests {
    @Fact
    func LogicalAnd_DoesNotEvaluateRight_WhenLeftIsFalse() {
        const Source = `package ShortAndFalse
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = false && sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndFalse"))
        Assert.Equal("0", lines[0])
        Assert.Equal("False", lines[1])
    }

    @Fact
    func LogicalOr_DoesNotEvaluateRight_WhenLeftIsTrue() {
        const Source = `package ShortOrTrue
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return false
}
var r = true || sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrTrue"))
        Assert.Equal("0", lines[0])
        Assert.Equal("True", lines[1])
    }

    @Fact
    func LogicalAnd_EvaluatesRight_WhenLeftIsTrue() {
        const Source = `package ShortAndTrue
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = true && sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndTrue"))
        Assert.Equal("1", lines[0])
        Assert.Equal("True", lines[1])
    }

    @Fact
    func LogicalOr_EvaluatesRight_WhenLeftIsFalse() {
        const Source = `package ShortOrFalse
import System
var counter = 0
func sideEffect() bool {
    counter = counter + 1
    return true
}
var r = false || sideEffect()
Console.WriteLine(counter)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrFalse"))
        Assert.Equal("1", lines[0])
        Assert.Equal("True", lines[1])
    }

    @Fact
    func LogicalAnd_ChainsShortCircuit_StopsAtFirstFalse() {
        const Source = `package ShortAndChain
import System
var aCount = 0
var bCount = 0
var cCount = 0
func a() bool {
    aCount = aCount + 1
    return true
}
func b() bool {
    bCount = bCount + 1
    return false
}
func c() bool {
    cCount = cCount + 1
    return true
}
var r = a() && b() && c()
Console.WriteLine(aCount)
Console.WriteLine(bCount)
Console.WriteLine(cCount)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-AndChain"))
        Assert.Equal("1", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("0", lines[2])
        Assert.Equal("False", lines[3])
    }

    @Fact
    func LogicalOr_ChainsShortCircuit_StopsAtFirstTrue() {
        const Source = `package ShortOrChain
import System
var aCount = 0
var bCount = 0
var cCount = 0
func a() bool {
    aCount = aCount + 1
    return false
}
func b() bool {
    bCount = bCount + 1
    return true
}
func c() bool {
    cCount = cCount + 1
    return false
}
var r = a() || b() || c()
Console.WriteLine(aCount)
Console.WriteLine(bCount)
Console.WriteLine(cCount)
Console.WriteLine(r)
`
        let lines = SplitLines(CompileLoadInvokeCaptureStdout(Source, "ShortCircuit-OrChain"))
        Assert.Equal("1", lines[0])
        Assert.Equal("1", lines[1])
        Assert.Equal("0", lines[2])
        Assert.Equal("True", lines[3])
    }

    shared {
        private func SplitLines(output string)[]string -> output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)

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
