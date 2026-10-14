// <copyright file="RefLocalAliasingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import GSharp.Repl.Engine
import System
import System.IO
import Xunit

/// Issue #491 (ADR-0060 follow-up): tests for ref-aliasing locals
/// (`let ref` / `var ref`). Aliasing must observe writes to the
/// pointee through the alias and vice versa, via the IL emitter's
/// `ldloc; ldind` / `ldloc; stind` lowering. Historically these ran
/// on the tree-walking evaluator; since ADR-0156 Phase 3c (#3176) submissions
/// execute emitted, and the sources swapped the evaluator-only
/// `print(string(x))` builtins for `Console.WriteLine` (the
/// `print`/`string(T)` builtins were subsequently retired — issues
/// #3245 and #3246).
open class RefLocalAliasingInterpreterTests {
    @Fact
    func LetRef_WriteThroughAlias_UpdatesUnderlyingVariable() {
        let output = RunSubmission(`
func tweak() {
    var n = 10
    let ref m = n
    m = m + 5
    Console.WriteLine(n)
}
tweak()
`)
        Assert.Contains("15", output)
    }

    @Fact
    func LetRef_ReadThroughAlias_ObservesUnderlyingMutation() {
        let output = RunSubmission(`
func tweak() {
    var n = 10
    let ref m = n
    n = 42
    Console.WriteLine(m)
}
tweak()
`)
        Assert.Contains("42", output)
    }

    @Fact
    func LetRef_WriteThroughAlias_TwoWayObserved() {
        let output = RunSubmission(`
func tweak() {
    var n = 10
    let ref m = n
    m = m * 2
    n = n + 1
    Console.WriteLine(m)
    Console.WriteLine(n)
}
tweak()
`)
        // m and n must observe the same storage. After m *= 2 → n = 20.
        // After n += 1 → m reads 21.
        Assert.Contains("21", output)
    }

    @Fact
    func LetRef_AliasStructField_WritesThrough() {
        let output = RunSubmission(`
struct Counter {
    var Value int32
}

func tweak() {
    var c = Counter{Value: 1}
    let ref v = c.Value
    v = 7
    Console.WriteLine(c.Value)
}
tweak()
`)
        Assert.Contains("7", output)
    }

    @Fact
    func LetRef_ArrayIndexRead_CapturesOriginalElement() {
        let output = RunSubmission(`
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    i = 2
    Console.WriteLine(r)
}
probe()
`)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_ArrayIndexWrite_CapturesOriginalElement() {
        let output = RunSubmission(`
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    i = 2
    r = 99
    Console.WriteLine("${arr[0]},${arr[1]},${arr[2]}")
}
probe()
`)
        Assert.Equal("99,20,30${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_ArrayIndexWithoutIndexMutation_StillReadsAndWritesElement() {
        let output = RunSubmission(`
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    r = 99
    Console.WriteLine("${r},${arr[0]},${arr[1]},${arr[2]}")
}
probe()
`)
        Assert.Equal("99,99,20,30${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_ClassField_CapturesReceiverBeforeReassignment() {
        let output = RunSubmission(`
class Box {
    var Value int32
}

func probe() {
    var first = Box{Value: 10}
    var current = first
    let ref r = current.Value
    current = Box{Value: 20}
    r = 99
    Console.WriteLine("${r}|${first.Value}|${current.Value}")
}
probe()
`)
        Assert.Equal("99|99|20${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_BlockExpression_EvaluatesPrefixOnceAndCapturesElement() {
        let output = RunSubmission(`
func probe() {
    var original = []int32{10, 20, 30}
    var current = original
    let ref r = current[^1]
    current = []int32{40, 50, 60}
    r = 99
    Console.WriteLine("${r}|${original[0]},${original[1]},${original[2]}|${current[0]},${current[1]},${current[2]}")
}
probe()
`)
        Assert.Equal("99|10,20,99|40,50,60${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_FromEndNonConstantOffset_CapturesElementAtDeclaration() {
        // Issue #3247: `^expr` with a non-constant offset. The from-end prefix
        // (receiver + offset) is evaluated once at the declaration; mutating
        // the offset variable afterwards must not re-target the alias.
        let output = RunSubmission(`
func probe() {
    var arr = []int32{10, 20, 30}
    var k int32 = 2
    let ref r = arr[^k]
    k = 1
    r = 99
    Console.WriteLine("${r}|${arr[0]},${arr[1]},${arr[2]}")
}
probe()
`)
        Assert.Equal("99|10,99,30${Environment.NewLine}", output)
    }

    @Fact
    func VarRef_FromEndIndex_ReadsAndWritesThroughAlias() {
        // Issue #3247: the `var ref` spelling over `xs[^1]` — reads observe
        // direct element writes, and writes through the alias land in the
        // aliased element.
        let output = RunSubmission(`
func probe() {
    var arr = []int32{10, 20, 30}
    var ref r = arr[^1]
    arr[2] = 77
    Console.WriteLine(r)
    r = 99
    Console.WriteLine("${arr[0]},${arr[1]},${arr[2]}")
}
probe()
`)
        Assert.Equal("77${Environment.NewLine}10,20,99${Environment.NewLine}", output)
    }

    @Fact
    func LetRef_GlobalVariable_RemainsAliasedToGlobalSlot() {
        let output = RunSubmission(`
var value int32 = 10

func probe() {
    let ref r = value
    r = 55
    Console.WriteLine("${r}|${value}")
}
probe()
`)
        Assert.StartsWith("55|55${Environment.NewLine}", output, StringComparison.Ordinal)
    }

    @Fact
    func LetRef_UnmanagedPointerDereference_RunsEmittedAndSurfacesNilDeref() {
        // ADR-0156 Phase 3c (#3176): this test previously pinned GS0513
        // ("pointer operations are not supported in the interpreter") — an
        // evaluator-only diagnostic that retired with the tree-walking engine.
        // Under the emitted engine pointer ref-aliasing compiles and runs; the
        // nil dereference surfaces as a runtime NullReferenceException on the
        // cell (GSI002). The source swaps the interpreter-only (and since
        // #3245/#3246 retired) `print(string(r))` builtin for
        // Console.WriteLine, which the emitter supports.
        const Source = `import System
func probe() {
    unsafe {
        var p *int32 = nil
        let ref r = *p
        Console.WriteLine(r)
    }
}
probe()`
        using let engine = EmittedSessionEngine()
        let cell = engine.Evaluate(Source)
        let diagnostic = Assert.Single(cell.Diagnostics)
        Assert.True(cell.HasError)
        Assert.Equal("GSI002", diagnostic.Id)
        Assert.Contains("NullReferenceException", diagnostic.Message)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
