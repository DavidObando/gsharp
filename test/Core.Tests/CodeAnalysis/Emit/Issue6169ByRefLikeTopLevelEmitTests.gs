// <copyright file="Issue6169ByRefLikeTopLevelEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #6169 (ADR-0228): top-level by-ref-like (`ref struct`) bindings in
/// executable compilations live in entry-point local slots on `<Main>$`,
/// reusing the #3215 non-hoisted global storage mechanism, while library
/// compilations, cross-function/lambda accesses (GS9004), suspension crossings,
/// and heap escapes (GS0219) remain rejected.
open class Issue6169ByRefLikeTopLevelEmitTests {
    @Fact
    func ReadOnlySpanLiteral_TopLevel_EmitsEntryPointLocalAndPrintsLength() {
        let source = `
import System

let view readonly span[byte] = u8"hello"
Console.WriteLine(view.Length)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("5\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{source})
        Assert.DoesNotContain("view", fields)
    }

    @Fact
    func MutableSpan_TopLevel_MutatesUnderlyingArrayWithoutStaticField() {
        let source = `
import System

var a = []int32{1, 2, 3}
var s span[int32] = a
s[0] = 99
Console.WriteLine(a[0])
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("99\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{source})
        Assert.Contains("a", fields)
        Assert.DoesNotContain("s", fields)
    }

    @Fact
    func UserDeclaredRefStruct_TopLevel_MutatesAndCallsMethodInEntryPointLocals() {
        let source = `
import System

ref struct Counter {
    var Value int32

    func Inc() {
        Value = Value + 1
    }
}

var c = Counter{Value: 41}
c.Inc()
Console.WriteLine(c.Value)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("42\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{source})
        Assert.DoesNotContain("c", fields)
    }

    @Fact
    func TopLevelByRefLike_AcrossMultipleFilesInSamePackage_SharesEntryPointLocal() {
        let fileA = `
import System

let view readonly span[byte] = u8"hello"
`
        let fileB = `
import System

Console.WriteLine(view.Length)
`
        let result = EmittedOracle.Evaluate([]string{fileA, fileB})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("5\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{fileA, fileB})
        Assert.DoesNotContain("view", fields)
    }

    @Fact
    func TopLevelByRefLike_BeforeAndAfterAwait_IsPermitted() {
        let source = `
import System
import System.Threading.Tasks

let before readonly span[byte] = u8"hi"
Console.WriteLine(before.Length)
await Task.Delay(1)
let after readonly span[byte] = u8"hello"
Console.WriteLine(after.Length)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("2\n5\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{source})
        Assert.DoesNotContain("before", fields)
        Assert.DoesNotContain("after", fields)
    }

    @Fact
    func FunctionReferencingByRefLikeTopLevelVariable_ReportsGS9004() {
        let readResult = EmittedOracle.Evaluate(`
import System

let view readonly span[byte] = u8"hello"
Console.WriteLine(f())
func f() int32 { return view.Length }
`)
        Assert.Contains(readResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(readResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let writeIndexResult = EmittedOracle.Evaluate(`
import System

var a = []int32{1, 2, 3}
var s span[int32] = a
mutate()
func mutate() { s[0] = 99 }
`)
        Assert.Contains(writeIndexResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(writeIndexResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func LambdaReferencingByRefLikeTopLevelVariable_ReportsGS9004() {
        let result = EmittedOracle.Evaluate(`
import System

let view readonly span[byte] = u8"hello"
let f = func() int32 { return view.Length }
Console.WriteLine(f())
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func TopLevelByRefLike_LiveAcrossAwait_ReportsGS0219() {
        let result = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
Console.WriteLine(view.Length)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let writeIndexResult = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

var a = []int32{1, 2, 3}
var s span[int32] = a
await Task.Delay(1)
s[0] = 99
`)
        Assert.Contains(writeIndexResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(writeIndexResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let writeFieldResult = EmittedOracle.Evaluate(`
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
await Task.Delay(1)
c.Value = 99
`)
        Assert.Contains(writeFieldResult.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(writeFieldResult.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func ByRefLike_PointerAliasAcrossAwait_ReportsGS0219_AndBeforeAwaitIsPermitted() {
        let topLevelUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
var p = &c.Value
await Task.Delay(1)
Console.WriteLine(*p)
`)
        Assert.Contains(topLevelUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(topLevelUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let funcUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var p = &c.Value
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(funcUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(funcUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let safeBeforeAwait = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
var p = &c.Value
Console.WriteLine(*p)
await Task.Delay(1)
`)
        Assert.Empty(safeBeforeAwait.Diagnostics)
        Assert.Equal("42\n", safeBeforeAwait.Output)

        let branchedUnsafeFunc = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var p = &c.Value
    await Task.Delay(1)
    if flag {
        Console.WriteLine(*p)
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(branchedUnsafeFunc.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(branchedUnsafeFunc.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let safeReseatedAfterAwait = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
var x = 1
var p = &c.Value
Console.WriteLine(*p)
await Task.Delay(1)
p = &x
Console.WriteLine(*p)
`)
        Assert.Empty(safeReseatedAfterAwait.Diagnostics)
        Assert.Equal("42\n1\n", safeReseatedAfterAwait.Output)

        let conditionalArmUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    let choice = if flag { 0 } else {
        p = &x
        0
    }
    await Task.Delay(1)
    Console.WriteLine(*p + choice)
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(conditionalArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(conditionalArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let tryThrowAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func mayThrow() { throw InvalidOperationException("boom") }

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        mayThrow()
        p = &x
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(tryThrowAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(tryThrowAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let gotoReorderUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    goto setup
    use:
    let p = &c.Value
    await Task.Delay(1)
    Console.WriteLine(*p)
    return
    setup:
    goto use
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(gotoReorderUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(gotoReorderUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let arrayIndexByRefStructSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var a = []int32{10, 20, 30}
    var c = Counter{Value: 1}
    var p = &a[c.Value]
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(arrayIndexByRefStructSafe.Diagnostics)
        Assert.Equal("20\n", arrayIndexByRefStructSafe.Output)

        let switchStmtGuardUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    switch n {
        case 1 when { p = &c.Value; false } {
            p = &x
        }
        default { }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(switchStmtGuardUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchStmtGuardUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchExprGuardUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let v = switch n {
        case 1 when { p = &c.Value; false }: { p = &x; 0 }
        default: 0
    }
    await Task.Delay(1)
    Console.WriteLine(*p + v)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(switchExprGuardUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchExprGuardUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let catchFilterAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func mayThrow() { throw InvalidOperationException("boom") }

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        mayThrow()
    } catch when { p = &c.Value; true } { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(catchFilterAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(catchFilterAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let tryConditionalExprAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func mayThrow() { throw InvalidOperationException("boom") }

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        let ignored = if flag {
            p = &c.Value
            mayThrow()
            p = &x
            0
        } else {
            0
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(tryConditionalExprAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(tryConditionalExprAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchReturningArmSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    switch flag {
        case true {
            return
        }
        default {
            p = &x
        }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Empty(switchReturningArmSafe.Diagnostics)
        Assert.Equal("1\n", switchReturningArmSafe.Output)

        let blockExprFalseBranchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    let ignored = {
        if flag {
            p = &x
        }
        0
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Contains(blockExprFalseBranchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(blockExprFalseBranchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let conditionalAddressBranchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    let q = &(if flag { x } else { p = &x; x })
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(conditionalAddressBranchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(conditionalAddressBranchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchBreakArmUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    switch flag {
        case true {
            p = &c.Value
            break
        }
        default { }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(switchBreakArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchBreakArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let tryReseatFinallySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        p = &x
    } finally { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(tryReseatFinallySafe.Diagnostics)
        Assert.Equal("1\n", tryReseatFinallySafe.Output)
    }

    @Fact
    func TopLevelByRefLike_CapturedByGo_ReportsGS0219() {
        let result = EmittedOracle.Evaluate(`
import System

let view readonly span[byte] = u8"hello"
go Console.WriteLine(view.Length)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func TopLevelByRefLike_BoxedToObject_ReportsGS0219() {
        let result = EmittedOracle.Evaluate(`
import System

let view readonly span[byte] = u8"hello"
let o object = view
Console.WriteLine(o)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func TopLevelByRefLike_InLibraryCompilation_ReportsGS0219AndGS0285() {
        let result = EmittedOracle.Evaluate([]string{`
import System

let view readonly span[byte] = u8"hello"
`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0285")
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func TopLevelDeconstruct_OfSpan_EmitsEntryPointLocalWithoutStaticField() {
        let source = `
import System

struct SpanPair {
    var Values[]int32

    func Deconstruct(out head Span[int32], out len int32) {
        head = Span[int32](Values)
        len = head.Length
    }
}

let (head, len) = SpanPair{Values: []int32{10, 20, 30}}
head[0] = 77
Console.WriteLine(head[0] + len)
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("80\n", result.Output)
        let fields = EmitAndReadFieldNames([]string{source})
        Assert.DoesNotContain("head", fields)
        Assert.Contains("len", fields)
    }

    shared {
        private func EmitAndReadFieldNames(sources[]string) List[string] {
            let trees = sources.Select(
                (s string, idx int32) -> SyntaxTree.Parse(SourceText.From(s, "TopLevel${idx}.gs"))
            )
                .ToArray()
            using let peStream = MemoryStream()
            let compilation = Compilation(trees)
            let emitResult = compilation.Emit(peStream)
            Assert.True(
                emitResult.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    emitResult.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            return md
                .FieldDefinitions
                .Select(md.GetFieldDefinition)
                .Select((f FieldDefinition) -> md.GetString(f.Name))
                .ToList()
        }
    }
}
