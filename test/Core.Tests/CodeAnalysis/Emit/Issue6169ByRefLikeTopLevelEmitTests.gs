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

        let heapArrayElementSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Holder {
    var Values[]int32
}

async func run() Task {
    var h = Holder{Values: []int32{11, 22}}
    var p = &h.Values[0]
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(heapArrayElementSafe.Diagnostics)
        Assert.Equal("11\n", heapArrayElementSafe.Output)

        let heapSourceClassFieldSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

class Box {
    var Value int32
}

ref struct Holder {
    var Box Box
}

async func run() Task {
    var h = Holder{Box: Box{Value: 33}}
    var p = &h.Box.Value
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(heapSourceClassFieldSafe.Diagnostics)
        Assert.Equal("33\n", heapSourceClassFieldSafe.Output)

        let heapImportedClassFieldSafe = EmittedOracle.Evaluate(`
import System
import System.Runtime.CompilerServices
import System.Threading.Tasks

ref struct Holder {
    var ClrBox StrongBox[int32]
}

async func run() Task {
    var h = Holder{ClrBox: StrongBox[int32](44)}
    var p = &h.ClrBox.Value
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(heapImportedClassFieldSafe.Diagnostics)
        Assert.Equal("44\n", heapImportedClassFieldSafe.Output)

        let defaultBeforeGuardedCaseStmtUnsafe = EmittedOracle.Evaluate(`
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
        default { }
        case 1 when {
            p = &c.Value
            false
        } {
            p = &x
        }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(defaultBeforeGuardedCaseStmtUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(defaultBeforeGuardedCaseStmtUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let defaultBeforeGuardedCaseExprUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let r = switch n {
        default: 0
        case 1 when {
            p = &c.Value
            false
        }: { p = &x; 1 }
    }
    await Task.Delay(1)
    Console.WriteLine(*p + r)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(defaultBeforeGuardedCaseExprUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(defaultBeforeGuardedCaseExprUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let topLevelFallthroughAcrossAwaitUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
switch Environment.GetCommandLineArgs().Length {
    case 0 {
        await Task.Delay(1)
        fallthrough
    }
    default {
        Console.WriteLine(view.Length)
    }
}
`)
        Assert.Contains(topLevelFallthroughAcrossAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(topLevelFallthroughAcrossAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let topLevelEscapingGotoAcrossAwaitUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
switch Environment.GetCommandLineArgs().Length {
    case 0 {
        await Task.Delay(1)
        goto useView
    }
    default { }
}
return
useView:
Console.WriteLine(view.Length)
`)
        Assert.Contains(topLevelEscapingGotoAcrossAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(topLevelEscapingGotoAcrossAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchStmtPatternMutateUnsafe = EmittedOracle.Evaluate(`
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
        case > ({ p = &c.Value; 100 }) {
            p = &x
        }
        default { }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(switchStmtPatternMutateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchStmtPatternMutateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchExprPatternMutateUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let r = switch n {
        case > ({ p = &c.Value; 100 }): { p = &x; 1 }
        default: 0
    }
    await Task.Delay(1)
    Console.WriteLine(*p + r)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(switchExprPatternMutateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchExprPatternMutateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let crossArmInteriorLabelGotoUnsafe = EmittedOracle.Evaluate(`
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
        case 0 {
            p = &c.Value
            goto inner
        }
        default {
            p = &x
        inner:
            Console.WriteLine("here")
        }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(crossArmInteriorLabelGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(crossArmInteriorLabelGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let crossArmInteriorLabelLivenessUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
switch Environment.GetCommandLineArgs().Length {
    case 0 {
        await Task.Delay(1)
        goto useView
    }
    default {
        Console.WriteLine("default")
    useView:
        Console.WriteLine(view.Length)
    }
}
`)
        Assert.Contains(crossArmInteriorLabelLivenessUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(crossArmInteriorLabelLivenessUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let crossArmBackwardJumpLivenessUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
switch Environment.GetCommandLineArgs().Length {
    case 0 {
        Console.WriteLine("arm0")
    earlierUse:
        Console.WriteLine(view.Length)
    }
    default {
        await Task.Delay(1)
        goto earlierUse
    }
}
`)
        Assert.Contains(crossArmBackwardJumpLivenessUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(crossArmBackwardJumpLivenessUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let nestedReseatBeforeReadSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    await Task.Delay(1)
    let ignored = {
        p = &x
        Console.WriteLine(*p)
        0
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(nestedReseatBeforeReadSafe.Diagnostics)
        Assert.Equal("1\n", nestedReseatBeforeReadSafe.Output)

        let blockExprBackwardGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    goto setup
use:
    Console.WriteLine(view.Length)
    goto done
setup:
    goto use
done:
    Console.WriteLine(0)
    0
}
`)
        Assert.Contains(blockExprBackwardGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(blockExprBackwardGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let blockExprNestedSwitchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let flag = Environment.GetCommandLineArgs().Length == 999
await Task.Delay(1)
let ignored = {
    switch flag {
        case true {
            c = Counter{Value: 1}
        }
        default {
            Console.WriteLine(c.Value)
        }
    }
    0
}
`)
        Assert.Contains(blockExprNestedSwitchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(blockExprNestedSwitchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchGuardOverwriteSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r = switch n {
    case 1 when {
        c = Counter{Value: 42}
        true
    }: c.Value
    default: {
        c = Counter{Value: 1}
        c.Value
    }
}
Console.WriteLine(r)
`)
        Assert.Empty(switchGuardOverwriteSafe.Diagnostics)
        Assert.Equal("42\n", switchGuardOverwriteSafe.Output)

        let switchGuardOverwriteInnerAwaitUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
let r = switch n {
    case 1 when {
        c = Counter{Value: 42}
        true
    }: {
        await Task.Delay(1)
        c.Value
    }
    default: 0
}
Console.WriteLine(r)
`)
        Assert.Contains(switchGuardOverwriteInnerAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchGuardOverwriteInnerAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let crossArmTerminatingPrefixLabelUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
switch Environment.GetCommandLineArgs().Length {
    case 0 {
        await Task.Delay(1)
        goto useView
    }
    default {
        return
    useView:
        Console.WriteLine(view.Length)
    }
}
`)
        Assert.Contains(crossArmTerminatingPrefixLabelUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(crossArmTerminatingPrefixLabelUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let catchFilterOverwriteSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    try {
        throw InvalidOperationException("boom")
    } catch when ({
        c = Counter{Value: 42}
        true
    }) {
        Console.WriteLine(c.Value)
    }
    0
}
`)
        Assert.Empty(catchFilterOverwriteSafe.Diagnostics)
        Assert.Equal("42\n", catchFilterOverwriteSafe.Output)

        let tryGotoFinallyOverwriteSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    try {
        goto useCounter
    } finally {
        c = Counter{Value: 42}
    }
useCounter:
    Console.WriteLine(c.Value)
    0
}
`)
        Assert.Empty(tryGotoFinallyOverwriteSafe.Diagnostics)
        Assert.Equal("42\n", tryGotoFinallyOverwriteSafe.Output)

        let failedGuardAlwaysMatchExprSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r = switch n {
    case _ when {
        c = Counter{Value: 42}
        false
    }: 0
    default: c.Value
}
Console.WriteLine(r)
`)
        Assert.Empty(failedGuardAlwaysMatchExprSafe.Diagnostics)
        Assert.Equal("42\n", failedGuardAlwaysMatchExprSafe.Output)

        let failedGuardAlwaysMatchBlockStmtSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let ignored = {
    switch n {
        case _ when ({
            c = Counter{Value: 42}
            false
        }) { }
        default {
            Console.WriteLine(c.Value)
        }
    }
    0
}
`)
        Assert.Empty(failedGuardAlwaysMatchBlockStmtSafe.Diagnostics)
        Assert.Equal("42\n", failedGuardAlwaysMatchBlockStmtSafe.Output)

        let switchGuardOverwriteReadBeforeAwaitResultSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
let r = switch n {
    case 1 when {
        c = Counter{Value: 42}
        true
    }: {
        let m = c.Value
        await Task.Delay(1)
        m
    }
    default: 0
}
Console.WriteLine(r)
`)
        Assert.Empty(switchGuardOverwriteReadBeforeAwaitResultSafe.Diagnostics)
        Assert.Equal("42\n", switchGuardOverwriteReadBeforeAwaitResultSafe.Output)

        let switchPatternOverwriteReadBeforeAwaitGuardSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
let r = switch n {
    case > ({
        c = Counter{Value: 42}
        0
    }) when ({
        let m = c.Value
        await Task.Delay(1)
        m > 0
    }): 1
    default: 0
}
Console.WriteLine(r)
`)
        Assert.Empty(switchPatternOverwriteReadBeforeAwaitGuardSafe.Diagnostics)
        Assert.Equal("1\n", switchPatternOverwriteReadBeforeAwaitGuardSafe.Output)

        let negatedDiscardGuardSkippedUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r = switch n {
    case not _ when ({
        c = Counter{Value: 42}
        true
    }): 0
    default: c.Value
}
Console.WriteLine(r)
`)
        Assert.Contains(negatedDiscardGuardSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(negatedDiscardGuardSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let doubleNegatedDiscardGuardSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r = switch n {
    case not (not _) when ({
        c = Counter{Value: 42}
        false
    }): 0
    default: c.Value
}
Console.WriteLine(r)
`)
        Assert.Empty(doubleNegatedDiscardGuardSafe.Diagnostics)
        Assert.Equal("42\n", doubleNegatedDiscardGuardSafe.Output)

        let isPatternFailedTypeTestUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

class Box {
    var Value int32
}

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let value object = "not-a-box"
await Task.Delay(1)
let ok = value is Box{
    Value: > ({
        c = Counter{Value: 42}
        0
    })
}
Console.WriteLine("${ok},${c.Value}")
`)
        Assert.Contains(isPatternFailedTypeTestUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(isPatternFailedTypeTestUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let chainedAssignmentPointerAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    var q = (p = &c.Value)
    await Task.Delay(1)
    Console.WriteLine(*q)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(chainedAssignmentPointerAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(chainedAssignmentPointerAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let terminatingConditionalBranchSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    let r = if flag {
        return
    } else {
        c = Counter{Value: 42}
        0
    }
    Console.WriteLine(c.Value + r)
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Empty(terminatingConditionalBranchSafe.Diagnostics)
        Assert.Equal("42\n", terminatingConditionalBranchSafe.Output)

        let terminatingSwitchExprArmSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    let r = switch flag {
        case true: {
            return
        }
        default: {
            c = Counter{Value: 42}
            0
        }
    }
    Console.WriteLine(c.Value + r)
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Empty(terminatingSwitchExprArmSafe.Diagnostics)
        Assert.Equal("42\n", terminatingSwitchExprArmSafe.Output)

        let standaloneSwitchFailedGuardSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
switch n {
    case _ when ({
        c = Counter{Value: 42}
        false
    }) { }
    default {
        Console.WriteLine(c.Value)
    }
}
`)
        Assert.Empty(standaloneSwitchFailedGuardSafe.Diagnostics)
        Assert.Equal("42\n", standaloneSwitchFailedGuardSafe.Output)

        let initializerEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
var ignored = {
    goto useView
    0
}
return
useView:
Console.WriteLine(view.Length)
`)
        Assert.Contains(initializerEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(initializerEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let initializerEscapingGotoOverwrittenSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
var ignored = {
    c = Counter{Value: 42}
    goto useC
    0
}
return
useC:
Console.WriteLine(c.Value)
`)
        Assert.Empty(initializerEscapingGotoOverwrittenSafe.Diagnostics)
        Assert.Equal("42\n", initializerEscapingGotoOverwrittenSafe.Output)

        let declinedCatchFilterStandaloneSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
try {
    throw InvalidOperationException()
} catch when ({
    c = Counter{Value: 42}
    false
}) { } catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Empty(declinedCatchFilterStandaloneSafe.Diagnostics)
        Assert.Equal("42\n", declinedCatchFilterStandaloneSafe.Output)

        let declinedCatchFilterBlockExprSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    try {
        throw InvalidOperationException()
    } catch when ({
        c = Counter{Value: 42}
        false
    }) { } catch {
        Console.WriteLine(c.Value)
    }
    0
}
`)
        Assert.Empty(declinedCatchFilterBlockExprSafe.Diagnostics)
        Assert.Equal("42\n", declinedCatchFilterBlockExprSafe.Output)

        let typedFilterSkippedUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
try {
    throw InvalidOperationException()
} catch (ex ArgumentException) when ({
    c = Counter{Value: 42}
    false
}) { } catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(typedFilterSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(typedFilterSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let throwingFilterSkippedUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        throw InvalidOperationException()
    } catch when ({
        if flag {
            throw InvalidOperationException()
        }
        c = Counter{Value: 42}
        false
    }) { } catch {
        Console.WriteLine(c.Value)
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(throwingFilterSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(throwingFilterSkippedUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let impossibleSwitchExprAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let r = switch n {
        case not _ when ({
            p = &c.Value
            true
        }): 0
        default: 1
    }
    await Task.Delay(1)
    Console.WriteLine("${r},${*p}")
}

run(0).GetAwaiter().GetResult()
`)
        // Note: runtime `*p` value across conditional/unreachable `ref` re-seats
        // is tracked separately in #6182 (`RefInitializationHoister`). These tests
        // assert that `RefStructAsyncLivenessAnalyzer` does not emit false `GS0219`.
        Assert.Empty(impossibleSwitchExprAliasSafe.Diagnostics)
        Assert.StartsWith("1,", impossibleSwitchExprAliasSafe.Output)

        let impossibleStmtSwitchAliasSafe = EmittedOracle.Evaluate(`
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
        case not _ when ({
            p = &c.Value
            true
        }) { }
        default { }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Empty(impossibleStmtSwitchAliasSafe.Diagnostics)

        let shortCircuitPatternAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    if n is _ or > ({
        p = &c.Value
        0
    }) { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Empty(shortCircuitPatternAliasSafe.Diagnostics)

        let crossArmGotoIntoImpossibleArmUnsafe = EmittedOracle.Evaluate(`
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
        case 1 {
            p = &c.Value
            goto innerTarget
        }
        case not _ {
            innerTarget:
            break
        }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(1).GetAwaiter().GetResult()
`)
        Assert.Contains(crossArmGotoIntoImpossibleArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(crossArmGotoIntoImpossibleArmUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let blockExprFinallyNormalTryUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    try {
        Console.WriteLine("ok")
    } catch when ({
        c = Counter{Value: 42}
        false
    }) { } finally {
        Console.WriteLine(c.Value)
    }
    0
}
`)
        Assert.Contains(blockExprFinallyNormalTryUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(blockExprFinallyNormalTryUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let nestedInitializerEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = {
        goto useView
        0
    }
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(nestedInitializerEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(nestedInitializerEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let nestedInitializerEscapingGotoOverwrittenSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    var inner = {
        c = Counter{Value: 42}
        goto useC
        0
    }
    return
useC:
    Console.WriteLine(c.Value)
    0
}
`)
        Assert.Empty(nestedInitializerEscapingGotoOverwrittenSafe.Diagnostics)
        Assert.Equal("42\n", nestedInitializerEscapingGotoOverwrittenSafe.Output)

        let sourceDefinedExceptionNamedExceptionSkippedUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

class Exception : System.Exception {
}

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
try {
    throw System.InvalidOperationException()
} catch (ex Exception) when ({
    c = Counter{Value: 42}
    false
}) { } catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(
            sourceDefinedExceptionNamedExceptionSkippedUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            sourceDefinedExceptionNamedExceptionSkippedUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let conditionalResultBranchPointeeSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    var q = &(if flag {
        *p
    } else {
        p = &c.Value
        x
    })
    await Task.Delay(1)
    Console.WriteLine(*q)
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Empty(conditionalResultBranchPointeeSafe.Diagnostics)
        Assert.Equal("1\n", conditionalResultBranchPointeeSafe.Output)

        let conditionalExprBranchPointeeComp = Compilation(SyntaxTree.Parse(SourceText.From(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    var q = if flag {
        p
    } else {
        p = &c.Value
        (&x)
    }
    await Task.Delay(1)
    Console.WriteLine(*q)
}

run(true).GetAwaiter().GetResult()
`)))
        Assert.Empty(conditionalExprBranchPointeeComp.GetDiagnostics())

        let throwingTernaryAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    let _ = if flag {
        throw InvalidOperationException()
    } else {
        p = &x
        0
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Empty(throwingTernaryAliasSafe.Diagnostics)
        Assert.Equal("1\n", throwingTernaryAliasSafe.Output)

        let throwingNullCoalesceAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(s string?) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let _ = s ?? ({
        p = &c.Value
        throw InvalidOperationException()
    })
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run("ok").GetAwaiter().GetResult()
`)
        // Note: runtime `*p` value across conditional `ref` re-seats (`s ?? ({ p = ... })`
        // and `p = q` in `RefInitializationHoister`) is tracked separately in #6182.
        Assert.Empty(throwingNullCoalesceAliasSafe.Diagnostics)

        let declinedCatchAllFilterReseatAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    var q = &x
    try {
        throw InvalidOperationException()
    } catch when ({
        p = q
        false
    }) { } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(declinedCatchAllFilterReseatAliasSafe.Diagnostics)

        let declinedCatchAllFilterAddressReseatSafe = EmittedOracle.Evaluate(`
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
        throw InvalidOperationException()
    } catch when ({
        p = &x
        false
    }) { } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(declinedCatchAllFilterAddressReseatSafe.Diagnostics)
        Assert.Equal("1\n", declinedCatchAllFilterAddressReseatSafe.Output)

        let receiverBeforeIndexAddressOrderComp = Compilation(SyntaxTree.Parse(SourceText.From(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var a = []int32{7, 8}
    var p = &x
    var q = &({
        p = &c.Value
        a
    })[{
        p = &x
        0
    }]
    await Task.Delay(1)
    Console.WriteLine("${*p},${*q}")
}

run().GetAwaiter().GetResult()
`)))
        Assert.Empty(receiverBeforeIndexAddressOrderComp.GetDiagnostics())

        let receiverBeforeIndexAddressOrderSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var a = []int32{7, 8}
    var p = &x
    let elem = *(&({
        p = &c.Value
        a
    })[{
        p = &x
        0
    }])
    await Task.Delay(1)
    Console.WriteLine("${*p},${elem}")
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(receiverBeforeIndexAddressOrderSafe.Diagnostics)
        Assert.Equal("1,7\n", receiverBeforeIndexAddressOrderSafe.Output)

        let throwingFilterAliasesPropagateUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func mayThrow() {
    throw InvalidOperationException()
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        throw InvalidOperationException()
    } catch when ({
        p = &c.Value
        mayThrow()
        p = &x
        false
    }) { } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(throwingFilterAliasesPropagateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(throwingFilterAliasesPropagateUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchGuardEscapingGotoUnsafe = EmittedOracle.Evaluate(`
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
        case _ when ({
            p = &c.Value
            goto resume
            true
        }) { }
        default { }
    }
    return
resume:
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchGuardEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchGuardEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchPatternEscapingGotoUnsafe = EmittedOracle.Evaluate(`
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
        case > ({
            p = &c.Value
            goto resume
            0
        }) { }
        default { }
    }
    return
resume:
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchPatternEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchPatternEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let earlyReturnBeforeOverwriteTryFinallyUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        if flag {
            return
        }
        c = Counter{Value: 20}
    } catch when ({
        c = Counter{Value: 42}
        false
    }) { } finally {
        Console.WriteLine(c.Value)
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(earlyReturnBeforeOverwriteTryFinallyUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            earlyReturnBeforeOverwriteTryFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let earlyReturnBeforeOverwriteBlockExprTryFinallyUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    let ignored = {
        try {
            if flag {
                return
            }
            c = Counter{Value: 20}
        } catch when ({
            c = Counter{Value: 42}
            false
        }) { } finally {
            Console.WriteLine(c.Value)
        }
        0
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(
            earlyReturnBeforeOverwriteBlockExprTryFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            earlyReturnBeforeOverwriteBlockExprTryFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let earlyReturnAfterOverwriteTryFinallySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 1}
    await Task.Delay(1)
    try {
        if flag {
            c = Counter{Value: 10}
            return
        }
        c = Counter{Value: 20}
    } catch when ({
        c = Counter{Value: 42}
        false
    }) { } finally {
        Console.WriteLine(c.Value)
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Empty(earlyReturnAfterOverwriteTryFinallySafe.Diagnostics)
        Assert.Equal("10\n", earlyReturnAfterOverwriteTryFinallySafe.Output)

        let escapingGotoBeforeOverwriteTryFinallyUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        if flag {
            goto done
        }
        c = Counter{Value: 20}
    } catch when ({
        c = Counter{Value: 42}
        false
    }) { } finally {
        Console.WriteLine(c.Value)
    }
done:
    Console.WriteLine("done")
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(escapingGotoBeforeOverwriteTryFinallyUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            escapingGotoBeforeOverwriteTryFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let isPatternEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = 1 is > ({
        goto useView
        0
    })
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(isPatternEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(isPatternEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let isOperandEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = ({
        goto useView
        1
    }) is > 0
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(isOperandEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(isOperandEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchExprDiscriminantEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = switch ({
        goto useView
        1
    }) {
        default: 0
    }
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(switchExprDiscriminantEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchExprDiscriminantEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let binaryPatternRightEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = 1 is (> 0 and < ({
        goto useView
        5
    }))
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(binaryPatternRightEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(binaryPatternRightEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let binaryPatternLeftEscapingGotoUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
let ignored = {
    var inner = 1 is (> ({
        goto useView
        0
    }) and < 5)
    return
useView:
    Console.WriteLine(view.Length)
    0
}
`)
        Assert.Contains(binaryPatternLeftEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(binaryPatternLeftEscapingGotoUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let isPatternEscapingGotoOverwrittenSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    var inner = 1 is > ({
        c = Counter{Value: 42}
        goto useC
        0
    })
    return
useC:
    Console.WriteLine(c.Value)
    0
}
`)
        Assert.Empty(isPatternEscapingGotoOverwrittenSafe.Diagnostics)
        Assert.Equal("42\n", isPatternEscapingGotoOverwrittenSafe.Output)

        let switchGuardToArmInteriorLabelAliasUnsafe = EmittedOracle.Evaluate(`
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
        case _ when ({
            p = &c.Value
            goto inner
            true
        }) {
            return
        inner:
            await Task.Delay(1)
            Console.WriteLine(*p)
        }
        default { }
    }
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchGuardToArmInteriorLabelAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchGuardToArmInteriorLabelAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchPatternToArmInteriorLabelViewUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

async func run(n int32) Task {
    let view readonly span[byte] = u8"hello"
    switch n {
        case > ({
            goto inner
            0
        }) {
            return
        inner:
            await Task.Delay(1)
            Console.WriteLine(view.Length)
        }
        default { }
    }
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchPatternToArmInteriorLabelViewUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(switchPatternToArmInteriorLabelViewUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let switchDiscriminantToArmInteriorLabelAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    switch ({
        p = &c.Value
        goto inner
        n
    }) {
        case 0 {
            return
        inner:
            await Task.Delay(1)
            Console.WriteLine(*p)
        }
        default { }
    }
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchDiscriminantToArmInteriorLabelAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            switchDiscriminantToArmInteriorLabelAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let switchDiscriminantToArmInteriorLabelViewUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

async func run(n int32) Task {
    let view readonly span[byte] = u8"hello"
    switch ({
        goto inner
        n
    }) {
        case 0 {
            return
        inner:
            await Task.Delay(1)
            Console.WriteLine(view.Length)
        }
        default { }
    }
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Contains(switchDiscriminantToArmInteriorLabelViewUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            switchDiscriminantToArmInteriorLabelViewUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let switchGuardToArmInteriorLabelOverwrittenSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    switch n {
        case _ when ({
            p = &x
            goto inner
            true
        }) {
            return
        inner:
            await Task.Delay(1)
            Console.WriteLine(*p)
        }
        default { }
    }
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Empty(switchGuardToArmInteriorLabelOverwrittenSafe.Diagnostics)
        Assert.Equal("1\n", switchGuardToArmInteriorLabelOverwrittenSafe.Output)

        let faultedAwaitBeforeOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func fail() Task {
    await Task.Delay(1)
    throw InvalidOperationException()
}

var c = Counter{Value: 10}
try {
    await fail()
    c = Counter{Value: 20}
} catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(faultedAwaitBeforeOverwriteCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            faultedAwaitBeforeOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let throwingRhsAwaitOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func getVal() Task[int32] {
    await Task.Delay(1)
    throw InvalidOperationException()
}

var c = Counter{Value: 10}
try {
    c = Counter{Value: await getVal()}
} catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(throwingRhsAwaitOverwriteCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(throwingRhsAwaitOverwriteCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let throwingPostAwaitOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func makeCounter() Counter {
    throw InvalidOperationException()
}

var c = Counter{Value: 10}
try {
    await Task.Delay(1)
    c = makeCounter()
} catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(throwingPostAwaitOverwriteCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            throwingPostAwaitOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let blockExprFaultedAwaitBeforeOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func fail() Task {
    await Task.Delay(1)
    throw InvalidOperationException()
}

var c = Counter{Value: 10}
try {
    let _ = {
        await fail()
        c = Counter{Value: 20}
        0
    }
} catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Contains(
            blockExprFaultedAwaitBeforeOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            blockExprFaultedAwaitBeforeOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let tryAwaitCatchFallsThroughToReadUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
try {
    await Task.Delay(1)
    c = Counter{Value: 20}
} catch {
    Console.WriteLine("err")
}
Console.WriteLine(c.Value)
`)
        Assert.Contains(tryAwaitCatchFallsThroughToReadUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(tryAwaitCatchFallsThroughToReadUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let tryAwaitAfterNonThrowingOverwriteCatchReturnsSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
try {
    await Task.Delay(1)
    c = Counter{Value: 20}
} catch {
    Console.WriteLine("err")
    return
}
Console.WriteLine(c.Value)
`)
        Assert.Empty(tryAwaitAfterNonThrowingOverwriteCatchReturnsSafe.Diagnostics)
        Assert.Equal("20\n", tryAwaitAfterNonThrowingOverwriteCatchReturnsSafe.Output)

        let tryNonThrowingOverwriteBeforeTryAwaitSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
try {
    c = Counter{Value: 20}
    throw InvalidOperationException()
} catch {
    Console.WriteLine(c.Value)
}
`)
        Assert.Empty(tryNonThrowingOverwriteBeforeTryAwaitSafe.Diagnostics)
        Assert.Equal("20\n", tryNonThrowingOverwriteBeforeTryAwaitSafe.Output)

        let ctorBackedStructLiteralInitializerThrowsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

func failInit() int32 {
    throw InvalidOperationException()
}

ref struct Counter {
    private var _tag int32 = 1
    var Value int32 = failInit()
}

async func run() Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        c = Counter{Value: 20}
    } catch {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(ctorBackedStructLiteralInitializerThrowsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            ctorBackedStructLiteralInitializerThrowsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let blockExprTryOverwriteBeforeThrowCatchSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
await Task.Delay(1)
let ignored = {
    try {
        c = Counter{Value: 20}
        throw InvalidOperationException()
    } catch {
        Console.WriteLine(c.Value)
    }
    0
}
`)
        Assert.Empty(blockExprTryOverwriteBeforeThrowCatchSafe.Diagnostics)
        Assert.Equal("20\n", blockExprTryOverwriteBeforeThrowCatchSafe.Output)

        let tryReseatAliasBeforeThrowCatchSafe = EmittedOracle.Evaluate(`
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
        throw InvalidOperationException()
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(tryReseatAliasBeforeThrowCatchSafe.Diagnostics)
        Assert.Equal("1\n", tryReseatAliasBeforeThrowCatchSafe.Output)

        let conversionUnboxingThrowsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(value object) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let n = int32(value)
        p = &x
        Console.WriteLine(n)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run("bad").GetAwaiter().GetResult()
`)
        Assert.Contains(conversionUnboxingThrowsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            conversionUnboxingThrowsRetainsAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let conversionUnboxingThrowsBlockExprCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(value object) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        let _ = {
            let n = int32(value)
            c = Counter{Value: n}
            0
        }
    } catch {
        Console.WriteLine(c.Value)
    }
}

run("bad").GetAwaiter().GetResult()
`)
        Assert.Contains(
            conversionUnboxingThrowsBlockExprCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            conversionUnboxingThrowsBlockExprCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let wideningNumericConversionNonThrowingSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        p = &x
        let wide int64 = int64(n)
        if wide >= 0 {
            throw InvalidOperationException()
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(5).GetAwaiter().GetResult()
`)
        Assert.Empty(wideningNumericConversionNonThrowingSafe.Diagnostics)
        Assert.Equal("1\n", wideningNumericConversionNonThrowingSafe.Output)

        let propertyPatternGetterThrowsInIsExprUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class Probe {
    prop Value int32 -> throw InvalidOperationException()
}

async func run(probe Probe) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let ok = probe is { Value: _ }
        p = &x
        Console.WriteLine(ok)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(Probe()).GetAwaiter().GetResult()
`)
        Assert.Contains(propertyPatternGetterThrowsInIsExprUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(propertyPatternGetterThrowsInIsExprUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let propertyPatternGetterThrowsInSwitchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class Probe {
    prop Value int32 -> throw InvalidOperationException()
}

async func run(probe Probe) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        switch probe {
            case { Value: _ } { }
        }
        p = &x
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(Probe()).GetAwaiter().GetResult()
`)
        Assert.Contains(propertyPatternGetterThrowsInSwitchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(propertyPatternGetterThrowsInSwitchUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let propertyPatternGetterThrowsOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class Probe {
    prop Value int32 -> throw InvalidOperationException()
}

async func run(probe Probe) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        let ok = probe is { Value: _ }
        c = Counter{Value: 20}
        Console.WriteLine(ok)
    } catch {
        Console.WriteLine(c.Value)
    }
}

run(Probe()).GetAwaiter().GetResult()
`)
        Assert.Contains(
            propertyPatternGetterThrowsOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            propertyPatternGetterThrowsOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let handledCatchAllReseatBeforeFinallyAwaitSafe = EmittedOracle.Evaluate(`
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
        throw InvalidOperationException()
    } catch {
        p = &x
    } finally {
        await Task.Delay(1)
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(handledCatchAllReseatBeforeFinallyAwaitSafe.Diagnostics)
        Assert.Equal("1\n", handledCatchAllReseatBeforeFinallyAwaitSafe.Output)

        let typedCatchNotMatchedFinallyAwaitUnsafe = EmittedOracle.Evaluate(`
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
        throw InvalidOperationException()
    } catch (ex ArgumentException) {
        p = &x
    } finally {
        await Task.Delay(1)
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(typedCatchNotMatchedFinallyAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(typedCatchNotMatchedFinallyAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let decimalToIntConversionThrowsCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(d decimal) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        let n = int32(d)
        c = Counter{Value: n}
    } catch {
        Console.WriteLine(c.Value)
    }
}

run(decimal.MaxValue).GetAwaiter().GetResult()
`)
        Assert.Contains(decimalToIntConversionThrowsCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            decimalToIntConversionThrowsCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let floatToDecimalConversionThrowsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(f float64) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let d = decimal(f)
        p = &x
        Console.WriteLine(d)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(1e30).GetAwaiter().GetResult()
`)
        Assert.Contains(
            floatToDecimalConversionThrowsRetainsAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            floatToDecimalConversionThrowsRetainsAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let addressOfOutOfBoundsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var a = []int32{1}
    var p = &c.Value
    try {
        let q = &a[99]
        p = q
        return
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(addressOfOutOfBoundsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(addressOfOutOfBoundsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let listPatternGetterThrowsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Collections.Generic
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(items List[int32]) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let ok = items is []
        p = &x
        Console.WriteLine(ok)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(List[int32]()).GetAwaiter().GetResult()
`)
        Assert.Contains(listPatternGetterThrowsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(listPatternGetterThrowsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let listPatternIndexerGetterThrowsOverwriteCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Collections.Generic
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(items List[int32]) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        let ok = items is [1]
        c = Counter{Value: 20}
        Console.WriteLine(ok)
    } catch {
        Console.WriteLine(c.Value)
    }
}

run(List[int32]()).GetAwaiter().GetResult()
`)
        Assert.Contains(
            listPatternIndexerGetterThrowsOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            listPatternIndexerGetterThrowsOverwriteCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let innerFinallyAddsRefAliasPropagatesToOuterCatchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        try {
            throw InvalidOperationException()
        } finally {
            p = &c.Value
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            innerFinallyAddsRefAliasPropagatesToOuterCatchUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            innerFinallyAddsRefAliasPropagatesToOuterCatchUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let innerFinallyRemovesRefAliasClearedForOuterCatchSafe = EmittedOracle.Evaluate(`
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
        try {
            throw InvalidOperationException()
        } finally {
            p = &x
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(innerFinallyRemovesRefAliasClearedForOuterCatchSafe.Diagnostics)
        Assert.Equal("1\n", innerFinallyRemovesRefAliasClearedForOuterCatchSafe.Output)

        let throwingFilterHandledByLaterCatchAllBeforeFinallySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func failFilter() bool {
    throw InvalidOperationException()
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        throw InvalidOperationException()
    } catch when (failFilter()) {
        p = &x
    } catch {
        p = &x
    } finally {
        await Task.Delay(1)
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(throwingFilterHandledByLaterCatchAllBeforeFinallySafe.Diagnostics)
        Assert.Equal("1\n", throwingFilterHandledByLaterCatchAllBeforeFinallySafe.Output)

        let throwingFilterOverwriteHandledByLaterCatchAllBeforeFinallySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func failFilter() bool {
    throw InvalidOperationException()
}

async func run() Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    try {
        throw InvalidOperationException()
    } catch when (failFilter()) {
        c = Counter{Value: 20}
    } catch {
        c = Counter{Value: 30}
    } finally {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(throwingFilterOverwriteHandledByLaterCatchAllBeforeFinallySafe.Diagnostics)
        Assert.Equal("30\n", throwingFilterOverwriteHandledByLaterCatchAllBeforeFinallySafe.Output)

        let trySwitchNormalPatternAndGuardReseatSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        switch n {
            case 0 when true {
                p = &x
            }
            default {
                p = &x
            }
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(0).GetAwaiter().GetResult()
`)
        Assert.Empty(trySwitchNormalPatternAndGuardReseatSafe.Diagnostics)
        Assert.Equal("1\n", trySwitchNormalPatternAndGuardReseatSafe.Output)

        let dataStructEqualityThrowsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

data class Key {
    var Id int32

    override func Equals(obj object?) bool -> throw InvalidOperationException()
    override func GetHashCode() int32 -> Id
}

async func run(a Key, b Key) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let eq = a == b
        p = &x
        Console.WriteLine(eq)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(Key{Id: 1}, Key{Id: 2}).GetAwaiter().GetResult()
`)
        Assert.Contains(dataStructEqualityThrowsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            dataStructEqualityThrowsRetainsAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let nestedTrySwitchPropertyPatternGetterThrowsFinallyAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class Probe {
    prop Value int32 -> throw InvalidOperationException()
}

async func run(probe Probe) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        try {
            switch probe {
                case { Value: _ } { }
            }
        } finally {
            p = &c.Value
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(Probe()).GetAwaiter().GetResult()
`)
        Assert.Contains(
            nestedTrySwitchPropertyPatternGetterThrowsFinallyAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            nestedTrySwitchPropertyPatternGetterThrowsFinallyAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let typedCatchTerminatingFilterPreservesMismatchPathUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

func reseatAndThrow(fn() -> void) bool {
    fn()
    throw InvalidOperationException()
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        throw InvalidOperationException()
    } catch (ex ArgumentException) when (reseatAndThrow(() -> { p = &x })) {
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            typedCatchTerminatingFilterPreservesMismatchPathUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            typedCatchTerminatingFilterPreservesMismatchPathUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let tryReturnPathAliasReachesFinallyAwaitUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var p = &c.Value
    await Task.Delay(1)
    try {
        return
    } finally {
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(tryReturnPathAliasReachesFinallyAwaitUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            tryReturnPathAliasReachesFinallyAwaitUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let nestedTryReturnPathWithFinallyAliasReachesOuterFinallyAwaitUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        try {
            return
        } finally {
            p = &c.Value
        }
    } finally {
        await Task.Delay(1)
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            nestedTryReturnPathWithFinallyAliasReachesOuterFinallyAwaitUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            nestedTryReturnPathWithFinallyAliasReachesOuterFinallyAwaitUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let tryReturnPathAliasReachesFinallyAfterSwitchUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        return
    } finally {
        await Task.Delay(1)
        Console.WriteLine(*p)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            tryReturnPathAliasReachesFinallyAfterSwitchUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            tryReturnPathAliasReachesFinallyAfterSwitchUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let nonThrowingTrySkipsCatchAliasSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var p = default(*int32)
    var outVal = 1
    try {
        outVal = 2
    } catch {
        p = &c.Value
    }
    await Task.Delay(1)
    if outVal == 0 {
        Console.WriteLine(*p)
    } else {
        Console.WriteLine(outVal)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(nonThrowingTrySkipsCatchAliasSafe.Diagnostics)
        Assert.Equal("2\n", nonThrowingTrySkipsCatchAliasSafe.Output)

        let switchExternalAndHeaderGotoMergeIntersectsOverwritesUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    await Task.Delay(1)
    if flag {
        goto armLabel
    }
    switch ({
        c = Counter{Value: 99}
        goto armLabel
        0
    }) {
        case 1 {
            armLabel:
            Console.WriteLine(c.Value)
        }
        default { }
    }
}

run(true).GetAwaiter().GetResult()
`)
        Assert.Contains(
            switchExternalAndHeaderGotoMergeIntersectsOverwritesUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            switchExternalAndHeaderGotoMergeIntersectsOverwritesUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let preconstructedThrowInBlockExpressionCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    let ex = InvalidOperationException()
    await Task.Delay(1)
    let _ = {
        try {
            throw ex
        } catch {
            Console.WriteLine(c.Value)
        }
        1
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            preconstructedThrowInBlockExpressionCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            preconstructedThrowInBlockExpressionCatchReadsUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let objectConstantPatternThrowsRetainsAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class ThrowEq {
    override func Equals(obj object?) bool -> throw InvalidOperationException()
    override func GetHashCode() int32 -> 1
}

async func run(a object) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        p = &c.Value
        let ok = a is 42
        p = &x
        Console.WriteLine(ok)
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(ThrowEq()).GetAwaiter().GetResult()
`)
        Assert.Contains(objectConstantPatternThrowsRetainsAliasUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(
            objectConstantPatternThrowsRetainsAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let switchObjectConstantPatternThrowsIntoFinallyAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class ThrowEq {
    override func Equals(obj object?) bool -> throw InvalidOperationException()
    override func GetHashCode() int32 -> 1
}

async func run(a object) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        try {
            switch a {
                case 42 { }
            }
        } finally {
            p = &c.Value
        }
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(ThrowEq()).GetAwaiter().GetResult()
`)
        Assert.Contains(
            switchObjectConstantPatternThrowsIntoFinallyAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            switchObjectConstantPatternThrowsIntoFinallyAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let deepNestedTryFinallyCompletesLinearlySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    Console.WriteLine(c.Value)
    await Task.Delay(1)
    try { Console.WriteLine(0) } finally {
        try { Console.WriteLine(0) } finally {
            try { Console.WriteLine(0) } finally {
                try { Console.WriteLine(0) } finally {
                    try { Console.WriteLine(0) } finally {
                        try { Console.WriteLine(0) } finally {
                            try { Console.WriteLine(0) } finally {
                                try { Console.WriteLine(0) } finally {
                                    try { Console.WriteLine(0) } finally {
                                        try { Console.WriteLine(0) } finally {
                                            try { Console.WriteLine(0) } finally {
                                                try { Console.WriteLine(0) } finally {
                                                    try { Console.WriteLine(0) } finally {
                                                        try { Console.WriteLine(0) } finally {
                                                            try { Console.WriteLine(0) } finally {
                                                                try { Console.WriteLine(0) } finally {
                                                                    try { Console.WriteLine(0) } finally {
                                                                        try { Console.WriteLine(1) } finally { }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(deepNestedTryFinallyCompletesLinearlySafe.Diagnostics)
        Assert.EndsWith("\n1\n", deepNestedTryFinallyCompletesLinearlySafe.Output)

        let deepNestedInitializerTryFinallyCompletesLinearlySafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    Console.WriteLine(c.Value)
    await Task.Delay(1)
    let r = {
        if true {
            try { Console.WriteLine(0) } finally {
                try { Console.WriteLine(0) } finally {
                    try { Console.WriteLine(0) } finally {
                        try { Console.WriteLine(0) } finally {
                            try { Console.WriteLine(0) } finally {
                                try { Console.WriteLine(0) } finally {
                                    try { Console.WriteLine(0) } finally {
                                        try { Console.WriteLine(0) } finally {
                                            try { Console.WriteLine(0) } finally {
                                                try { Console.WriteLine(0) } finally {
                                                    try { Console.WriteLine(0) } finally {
                                                        try { Console.WriteLine(0) } finally {
                                                            try { Console.WriteLine(0) } finally {
                                                                try { Console.WriteLine(0) } finally {
                                                                    try { Console.WriteLine(0) } finally {
                                                                        try { Console.WriteLine(0) } finally {
                                                                            Console.WriteLine(1)
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        1
    }
    Console.WriteLine(r)
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(deepNestedInitializerTryFinallyCompletesLinearlySafe.Diagnostics)
        Assert.EndsWith("\n1\n1\n", deepNestedInitializerTryFinallyCompletesLinearlySafe.Output)

        let throwingSwitchGuardSkipsUnreachableArmAwaitSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"

try {
    await Task.Delay(1)
    let r = switch 0 {
        case _ when throw InvalidOperationException(): view.Length
        default: 0
    }
    Console.WriteLine(r)
} catch {
    Console.WriteLine("caught-expr")
}

try {
    switch 0 {
        case _ when throw InvalidOperationException() {
            await Task.Delay(1)
            Console.WriteLine(view.Length)
        }
        default { }
    }
} catch {
    Console.WriteLine("caught-stmt")
}
`)
        Assert.Empty(throwingSwitchGuardSkipsUnreachableArmAwaitSafe.Diagnostics)
        Assert.Equal("caught-expr\ncaught-stmt\n", throwingSwitchGuardSkipsUnreachableArmAwaitSafe.Output)

        let unreachableCatchWithAwaitSkipsSpanSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
try {
    var n = 1
} catch {
    await Task.Delay(1)
    Console.WriteLine(view.Length)
}
Console.WriteLine(1)
`)
        Assert.Empty(unreachableCatchWithAwaitSkipsSpanSafe.Diagnostics)
        Assert.Equal("1\n", unreachableCatchWithAwaitSkipsSpanSafe.Output)

        let nativeRefAliasReadThrowsCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var ptr = default(*int32)
    await Task.Delay(1)
    var ref dst = *ptr
    try {
        let n = dst
        Console.WriteLine(n)
    } catch {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(nativeRefAliasReadThrowsCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(nativeRefAliasReadThrowsCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let nativeRefAliasWriteThrowsCatchReadsUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var ptr = default(*int32)
    await Task.Delay(1)
    var ref dst = *ptr
    try {
        dst = 1
    } catch {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(nativeRefAliasWriteThrowsCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.DoesNotContain(nativeRefAliasWriteThrowsCatchReadsUnsafe.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")

        let nativeRefAliasWriteThrowsRetainsPointerAliasUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    var ptr = default(*int32)
    var ref dst = *ptr
    try {
        p = &c.Value
        dst = 1
        p = &x
    } catch { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            nativeRefAliasWriteThrowsRetainsPointerAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            nativeRefAliasWriteThrowsRetainsPointerAliasUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let outerFilterLivenessPreservedAcrossInnerFinallyOverwriteUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    await Task.Delay(1)
    try {
        try {
            throw InvalidOperationException()
        } finally {
            c = Counter{Value: 99}
        }
    } catch when (c.Value == 42) { }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            outerFilterLivenessPreservedAcrossInnerFinallyOverwriteUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            outerFilterLivenessPreservedAcrossInnerFinallyOverwriteUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let outerCatchBodyAfterInnerFinallyOverwriteSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    await Task.Delay(1)
    try {
        try {
            throw InvalidOperationException()
        } finally {
            c = Counter{Value: 99}
        }
    } catch {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Empty(outerCatchBodyAfterInnerFinallyOverwriteSafe.Diagnostics)
        Assert.Equal("99\n", outerCatchBodyAfterInnerFinallyOverwriteSafe.Output)

        let outerCatchLivenessPropagatesThroughNonThrowingInnerFinallyUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    await Task.Delay(1)
    try {
        try {
            throw InvalidOperationException()
        } finally {
            var marker = 0
        }
    } catch {
        Console.WriteLine(c.Value)
    }
}

run().GetAwaiter().GetResult()
`)
        Assert.Contains(
            outerCatchLivenessPropagatesThroughNonThrowingInnerFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            outerCatchLivenessPropagatesThroughNonThrowingInnerFinallyUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let throwingSwitchPatternCarriesHandlerLivenessUnsafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

class Probe {
    prop Value int32 -> throw InvalidOperationException()
}

async func run(probe Probe) Task {
    var c = Counter{Value: 42}
    await Task.Delay(1)
    try {
        switch probe {
            case { Value: _ } { }
        }
    } catch {
        Console.WriteLine(c.Value)
    }
}

run(Probe()).GetAwaiter().GetResult()
`)
        Assert.Contains(
            throwingSwitchPatternCarriesHandlerLivenessUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0219"
        )
        Assert.DoesNotContain(
            throwingSwitchPatternCarriesHandlerLivenessUnsafe.Diagnostics,
            (d Diagnostic) -> d.Id == "GS9998"
        )

        let throwingGuardSwitchExprSkipsPointerMutationSafe = EmittedOracle.Evaluate(`
import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(readPtr bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    try {
        let _ = switch 0 {
            case _ when throw InvalidOperationException(): {
                p = &c.Value
                0
            }
            default: 0
        }
    } catch { }
    await Task.Delay(1)
    if readPtr {
        Console.WriteLine(*p)
    } else {
        Console.WriteLine(1)
    }
}

run(false).GetAwaiter().GetResult()
`)
        Assert.Empty(throwingGuardSwitchExprSkipsPointerMutationSafe.Diagnostics)
        Assert.Equal("1\n", throwingGuardSwitchExprSkipsPointerMutationSafe.Output)
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
