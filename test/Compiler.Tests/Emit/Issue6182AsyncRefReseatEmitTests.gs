// <copyright file="Issue6182AsyncRefReseatEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #6182: `RefInitializationHoister` must preserve dynamic control flow
/// when a `ByRefTypeSymbol` local (`var p = &x`) is conditionally, loop-, or
/// guard-re-seated inside an `async` method or async iterator.
open class Issue6182AsyncRefReseatEmitTests {
    @Fact
    func Issue6182Repro_UnreachableIfFalseReseat_PreservesInitialTarget() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Repro6182
import System
import System.Threading.Tasks

async func run() Task {
    var x = 1
    var y = 77
    var p = &x
    if false {
        p = &y
    }
    Console.WriteLine("before=${*p}")
    await Task.Delay(1)
    Console.WriteLine("after=${*p}")
}

run().GetAwaiter().GetResult()`, "Repro6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("before=1\nafter=1\n", fixture.Run(dll))
    }

    @Theory
    @InlineData(false, "before=1\nafter=1\n")
    @InlineData(true, "before=77\nafter=77\n")
    func DynamicIfBranchReseat_AcrossAwait_ReflectsRuntimeCondition(flag bool, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let arg = if flag {
            "true"
        } else {
            "false"
        }
        let dll = fixture.Compile(`package DynamicIf6182
import System
import System.Threading.Tasks

async func run(flag bool) Task {
    var x = 1
    var y = 77
    var p = &x
    if flag {
        p = &y
    }
    Console.WriteLine("before=${*p}")
    await Task.Delay(1)
    Console.WriteLine("after=${*p}")
}

run(` + arg + `).GetAwaiter().GetResult()`, "DynamicIf6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(expected, fixture.Run(dll))
    }

    @Fact
    func IfElseAndMultiBranchReseats_AcrossAwait_SelectTakenBranchOnly() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package MultiBranch6182
import System
import System.Threading.Tasks

async func either(cond bool) Task[int32] {
    var x = 1
    var y = 77
    var z = 99
    var p = &x
    if cond {
        p = &y
    } else {
        p = &z
    }
    await Task.Yield()
    return *p
}

async func chain(a bool, b bool) Task[int32] {
    var x = 1
    var y = 77
    var z = 99
    var p = &x
    if a {
        p = &y
    } else if b {
        p = &z
    }
    await Task.Yield()
    return *p
}

Console.WriteLine("${either(true).GetAwaiter().GetResult()}:${either(false).GetAwaiter().GetResult()}")
Console.WriteLine("${chain(false, false).GetAwaiter().GetResult()}:${chain(true, false).GetAwaiter().GetResult()}:${chain(false, true).GetAwaiter().GetResult()}")`, "MultiBranch6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("77:99\n1:77:99\n", fixture.Run(dll))
    }

    @Fact
    func PatternGuardAndShortCircuitReseats_AcrossAwait_RespectEvaluationOrder() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package PatternAndShortCircuit6182
import System
import System.Threading.Tasks

class Cell {
    var Value int32
    init(value int32) {
        Value = value
    }
}

async func switchGuardSkipped(n int32) Task[string] {
    var x = 1
    var c = Cell(77)
    var p = &x
    switch n {
        case not _ when ({
            p = &c.Value
            true
        }) { }
        default { }
    }
    let before = *p
    await Task.Yield()
    return "${before}:${*p}"
}

async func switchGuardTaken(n int32) Task[string] {
    var x = 1
    var c = Cell(77)
    var p = &x
    switch n {
        case _ when ({
            p = &c.Value
            false
        }) { }
        default { }
    }
    let before = *p
    await Task.Yield()
    return "${before}:${*p}"
}

async func isPatternOrShortCircuited(n int32) Task[string] {
    var x = 1
    var c = Cell(77)
    var p = &x
    let matched = n is _ or > ({
        p = &c.Value
        0
    })
    let before = *p
    await Task.Yield()
    return "${matched}:${before}:${*p}"
}

async func isPatternOrEvaluatesRight(n int32) Task[string] {
    var x = 1
    var c = Cell(77)
    var p = &x
    let matched = n is > 100 or > ({
        p = &c.Value
        0
    })
    let before = *p
    await Task.Yield()
    return "${matched}:${before}:${*p}"
}

async func logicalAndShortCircuit(cond bool) Task[string] {
    var x = 1
    var y = 77
    var p = &x
    let _ = cond && ({
        p = &y
        true
    })
    let before = *p
    await Task.Yield()
    return "${before}:${*p}"
}

Console.WriteLine(switchGuardSkipped(5).GetAwaiter().GetResult())
Console.WriteLine(switchGuardTaken(5).GetAwaiter().GetResult())
Console.WriteLine(isPatternOrShortCircuited(5).GetAwaiter().GetResult())
Console.WriteLine(isPatternOrEvaluatesRight(5).GetAwaiter().GetResult())
Console.WriteLine(logicalAndShortCircuit(false).GetAwaiter().GetResult())
Console.WriteLine(logicalAndShortCircuit(true).GetAwaiter().GetResult())`, "PatternAndShortCircuit6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("1:1\n77:77\nTrue:1:1\nTrue:77:77\n1:1\n77:77\n", fixture.Run(dll))
    }

    @Fact
    func LoopReseatsAndIndexSnapshots_AcrossAwait_TrackLatestExecutedIteration() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package LoopReseat6182
import System
import System.Threading.Tasks

async func conditionalInLoop() Task[string] {
    var x = 1
    var y = 77
    var p = &x
    var acc = ""
    for var i = 0; i < 3; i++ {
        if i == 1 {
            p = &y
        }
        await Task.Yield()
        acc += "${*p},"
    }
    return acc
}

async func arrayReseatSnapshotsIndex() Task[string] {
    var arr = []int32{10, 20, 30}
    var p = &arr[0]
    var acc = ""
    var k = 0
    while k < 3 {
        var idx = k
        p = &arr[idx]
        idx = 99
        await Task.Yield()
        acc += "${*p},"
        k++
    }
    return acc
}

Console.WriteLine(conditionalInLoop().GetAwaiter().GetResult())
Console.WriteLine(arrayReseatSnapshotsIndex().GetAwaiter().GetResult())`, "LoopReseat6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("1,77,77,\n10,20,30,\n", fixture.Run(dll))
    }

    @Fact
    func UnconditionalReseatWriteThroughAndRefArgument_AcrossAwait_TargetSelectedStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package UnconditionalAndWriteThrough6182
import System
import System.Threading
import System.Threading.Tasks

func bump(ref value int32) {
    value += 5
}

async func unconditional() Task[string] {
    var x = 1
    var y = 77
    var p = &x
    let first = *p
    p = &y
    await Task.Yield()
    *p = 88
    return "${first}:${*p}:${x}:${y}"
}

async func passByRefAfterConditional(flag bool) Task[string] {
    var x = 1
    var y = 77
    var p = &x
    if flag {
        p = &y
    }
    await Task.Yield()
    bump(&*p)
    let _ = Interlocked.Add(&*p, 1)
    return "${x}:${y}"
}

async func nonCrossingConditional(flag bool) Task[int32] {
    var x = 1
    var y = 77
    var p = &x
    if flag {
        p = &y
    }
    let before = *p
    await Task.Yield()
    return before
}

async func chainedAliasSnapshot(flag bool) Task[string] {
    var x = 1
    var y = 77
    var z = 99
    var p = &x
    if flag {
        p = &y
    }
    var q = p
    p = &z
    await Task.Yield()
    return "${*p}:${*q}"
}

Console.WriteLine(unconditional().GetAwaiter().GetResult())
Console.WriteLine(passByRefAfterConditional(false).GetAwaiter().GetResult())
Console.WriteLine(passByRefAfterConditional(true).GetAwaiter().GetResult())
Console.WriteLine("${nonCrossingConditional(false).GetAwaiter().GetResult()}:${nonCrossingConditional(true).GetAwaiter().GetResult()}")
Console.WriteLine(chainedAliasSnapshot(false).GetAwaiter().GetResult())
Console.WriteLine(chainedAliasSnapshot(true).GetAwaiter().GetResult())`, "UnconditionalAndWriteThrough6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("1:88:1:88\n7:77\n1:83\n1:77\n99:1\n99:77\n", fixture.Run(dll))
    }

    @Fact
    func AsyncLambdaAndAsyncIterator_WithConditionalReseat_ProduceExpectedResults() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package LambdaAndAsyncIter6182
import System
import System.Collections.Generic
import System.Threading.Tasks

func items(flag bool) IAsyncEnumerable[int32] {
    var x = 1
    var y = 77
    var p = &x
    if flag {
        p = &y
    }
    yield *p
    await Task.Yield()
    yield *p
}

async func run() Task {
    let fn = async func(flag bool) Task[string] {
        var a = 10
        var b = 20
        var p = &a
        if flag {
            p = &b
        }
        let first = *p
        await Task.Yield()
        return "${first}:${*p}"
    }
    Console.WriteLine(await fn(false))
    Console.WriteLine(await fn(true))
    await for item in items(false) {
        Console.Write("${item},")
    }
    Console.WriteLine()
    await for item in items(true) {
        Console.Write("${item},")
    }
    Console.WriteLine()
}

run().GetAwaiter().GetResult()`, "LambdaAndAsyncIter6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:10\n20:20\n1,1,\n77,77,\n", fixture.Run(dll))
    }

    @Fact
    func UnsafeUnmanagedPointer_And_VarRefAliasControl_KeepExistingContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package UnsafeUnmanaged6182
import System
import System.Runtime.InteropServices
import System.Threading.Tasks

unsafe async func run(flag bool) Task[string] {
    let buf = cast[*int32](Marshal.AllocHGlobal(8))
    try {
        buf[0] = 1
        buf[1] = 77
        var p *int32 = buf
        let ignored = (p = default(*int32))
        var q = p
        p = buf
        if flag {
            p = buf + 1
        }
        await Task.Yield()
        let isNull = q == nil && ignored == nil
        return "${*p}:${isNull}"
    } finally {
        Marshal.FreeHGlobal(nint(buf))
    }
}

Console.WriteLine("${run(false).GetAwaiter().GetResult()}:${run(true).GetAwaiter().GetResult()}")`, "UnsafeUnmanaged6182", executable: true)
        IlVerifier.Verify(dll, ignoredErrorCodes: []string{"UnmanagedPointer", "StackUnexpected", "StackByRef"})
        Assert.Equal("1:True:77:True\n", fixture.Run(dll))

        let (code, output) = fixture.TryCompile(`package VarRefReject6182
import System.Threading.Tasks

async func bad() Task {
    var x = 1
    var ref alias = x
    await Task.Delay(1)
    alias = 2
}`, "VarRefReject6182", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0258:", output, StringComparison.Ordinal)
    }

    @Fact
    func ConditionalArrayOutOfBoundsReseat_ProbesOnlyWhenTaken() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProbeTiming6182
import System
import System.Threading.Tasks

async func run(takeOutOfBounds bool) Task[string] {
    var arr = []int32{11}
    var p = &arr[0]
    if takeOutOfBounds {
        p = &arr[99]
    }
    await Task.Yield()
    return "${*p}"
}

Console.WriteLine(run(false).GetAwaiter().GetResult())
try {
    Console.WriteLine(run(true).GetAwaiter().GetResult())
} catch (IndexOutOfRangeException) {
    Console.WriteLine("caught")
}`, "ProbeTiming6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("11\ncaught\n", fixture.Run(dll))
    }

    @Fact
    func BothSelfConditional_CyclicAliasCopy_And_CaughtFailedProbe_PreserveActiveTarget() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CopilotFindings6182
import System
import System.Threading.Tasks

func sideEffect(ref calls int32, result bool) bool {
    calls++
    return result
}

async func bothSelfConditional() Task[string] {
    var x = 10
    var p = &x
    var calls = 0
    p = sideEffect(&calls, true) ? p : p
    await Task.Yield()
    return "${*p}:${calls}"
}

async func mutuallyDependentAliases(swap bool) Task[string] {
    var x = 11
    var y = 22
    var p = &x
    var q = p
    p = q
    if swap {
        var r = &y
        let tmp = p
        p = r
        r = tmp
    }
    await Task.Yield()
    return "${*p}:${*q}"
}

async func caughtFailedProbePreservesPreviousTarget() Task[string] {
    var arr = []int32{10, 20}
    var p = &arr[0]
    for var i = 0; i < 2; i++ {
        let idx = if i == 0 { 1 } else { 99 }
        try {
            p = &arr[idx]
        } catch (IndexOutOfRangeException) {
        }
    }
    await Task.Yield()
    return "${*p}"
}

Console.WriteLine(bothSelfConditional().GetAwaiter().GetResult())
Console.WriteLine(mutuallyDependentAliases(false).GetAwaiter().GetResult())
Console.WriteLine(mutuallyDependentAliases(true).GetAwaiter().GetResult())
Console.WriteLine(caughtFailedProbePreservesPreviousTarget().GetAwaiter().GetResult())`, "CopilotFindings6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:1\n11:11\n22:11\n20\n", fixture.Run(dll))
    }

    @Fact
    func CyclicAliasLoopSnapshot_And_CaughtConditionalProbe_PreserveTargets() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CopilotRound2LoopAndCond6182
import System
import System.Threading.Tasks

async func cyclicAliasSnapshotSurvivesLoopOverwrite() Task[string] {
    var arr = []int32{10, 20}
    var p = &arr[0]
    var q = p
    p = q
    for var i = 0; i < 2; i++ {
        var idx = i
        p = &arr[idx]
        if i == 0 {
            q = p
        }
    }
    await Task.Yield()
    return "${*p}:${*q}"
}

async func caughtConditionalFailedProbePreservesPreviousTarget() Task[string] {
    var arr = []int32{10, 20}
    var p = &arr[0]
    for var i = 0; i < 2; i++ {
        var idx = i
        try {
            p = (idx == 0) ? &arr[1] : &arr[99]
        } catch (IndexOutOfRangeException) {
        }
    }
    await Task.Yield()
    return "${*p}"
}

Console.WriteLine(cyclicAliasSnapshotSurvivesLoopOverwrite().GetAwaiter().GetResult())
Console.WriteLine(caughtConditionalFailedProbePreservesPreviousTarget().GetAwaiter().GetResult())`, "CopilotRound2LoopAndCond6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("20:10\n20\n", fixture.Run(dll))
    }

    @Fact
    func IndependentDifferentTypeAliasCycles_InSameMethod_VerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CopilotRound2MixedTypes6182
import System
import System.Threading.Tasks

async func independentDifferentTypeAliasCyclesInSameMethod(flag bool) Task[string] {
    var a = 1
    var b = 2
    var p = &a
    var q = p
    p = q
    var s1 = "hello"
    var s2 = "world"
    var sp = &s1
    var sq = sp
    sp = sq
    if flag {
        p = &b
        sp = &s2
    }
    await Task.Yield()
    return "${*p}:${*q}:${*sp}:${*sq}"
}

Console.WriteLine(independentDifferentTypeAliasCyclesInSameMethod(false).GetAwaiter().GetResult())
Console.WriteLine(independentDifferentTypeAliasCyclesInSameMethod(true).GetAwaiter().GetResult())`, "CopilotRound2MixedTypes6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("1:1:hello:hello\n2:1:world:hello\n", fixture.Run(dll))
    }

    @Fact
    func ConditionalInitializers_NestedSelfConditional_And_AddressOfDereference_Succeed() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CopilotRound3Findings6182
import System
import System.Threading.Tasks

async func cyclicConditionalInitializer(flag bool) Task[string] {
    var x = 10
    var y = 20
    var p = &x
    var q = &y
    var r = flag ? p : q
    p = r
    q = r
    await Task.Yield()
    return "${*p}:${*q}:${*r}"
}

async func loopConditionalInitializerSnapshot() Task[string] {
    var arr = []int32{10, 20, 30}
    var q = &arr[0]
    for var i = 0; i < 2; i++ {
        var idx = i
        var r = (idx == 0) ? &arr[idx] : &arr[2]
        if i == 0 {
            q = r
        }
        r = q
    }
    await Task.Yield()
    return "${*q}"
}

async func nestedConditionalSelfReseat(a bool, b bool) Task[string] {
    var x = 1
    var y = 77
    var z = 99
    var p = &x
    p = a ? (b ? p : &y) : &z
    await Task.Yield()
    return "${*p}"
}

async func addressOfDerefSelfAndCyclicCopy(flag bool) Task[string] {
    var x = 11
    var y = 22
    var p = &x
    p = &*p
    var q = &*p
    p = &*q
    if flag {
        p = &y
    }
    await Task.Yield()
    return "${*p}:${*q}"
}

Console.WriteLine(cyclicConditionalInitializer(true).GetAwaiter().GetResult())
Console.WriteLine(cyclicConditionalInitializer(false).GetAwaiter().GetResult())
Console.WriteLine(loopConditionalInitializerSnapshot().GetAwaiter().GetResult())
Console.WriteLine(nestedConditionalSelfReseat(true, true).GetAwaiter().GetResult())
Console.WriteLine(nestedConditionalSelfReseat(true, false).GetAwaiter().GetResult())
Console.WriteLine(nestedConditionalSelfReseat(false, true).GetAwaiter().GetResult())
Console.WriteLine(addressOfDerefSelfAndCyclicCopy(false).GetAwaiter().GetResult())
Console.WriteLine(addressOfDerefSelfAndCyclicCopy(true).GetAwaiter().GetResult())`, "CopilotRound3Findings6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:10:10\n20:20:20\n10\n1\n77\n99\n11:11\n22:11\n", fixture.Run(dll))
    }

    @Fact
    func NativeRefDependencies_BlockResultAliases_And_NonCompletingBranches_Succeed() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NativeRefBlockAndNonCompleting6182
import System
import System.Threading.Tasks

async func hoistedDependsOnNonCrossingNative(flag bool) Task[int32] {
    var x = 10
    var y = 77
    var n = &x
    if flag {
        n = &y
    }
    var m = n
    var h = m
    await Task.Yield()
    return *h
}

async func nonCrossingNativeDependsOnHoisted(flag bool) Task[string] {
    var x = 1
    var y = 77
    var z = 99
    var h = &x
    if flag {
        h = &y
    }
    var n = h
    h = &z
    let before = *n
    await Task.Yield()
    var ref afterAlias = *h
    afterAlias += 1
    return "${before}:${*h}:${z}"
}

async func hoistedAliasesOverwrittenVarRef() Task[string] {
    var x = 11
    var y = 22
    var ref alias = x
    var p = &alias
    alias = 15
    let before = *p
    p = &y
    await Task.Yield()
    return "${before}:${*p}"
}

async func blockResultAliasDeclAndReseat(flag bool, takeSecond bool) Task[string] {
    var x = 10
    var y = 20
    var z = 30
    var p = ({
        var tmp = &x
        if flag {
            tmp = &y
        }
        tmp
    })
    let first = *p
    p = takeSecond ? ({
        var tmp2 = &z
        tmp2
    }) : &x
    await Task.Yield()
    return "${first}:${*p}"
}

async func cyclicBlockResultAlias(flag bool) Task[string] {
    var x = 10
    var y = 20
    var q = &x
    var p = ({
        var tmp = q
        tmp
    })
    q = p
    if flag {
        p = &y
    }
    await Task.Yield()
    return "${*p}:${*q}"
}

async func statementNonCompletingBranches(mode int32) Task[string] {
    var x = 1
    var y = 77
    var z = 99
    var p = &x
    for var i = 0; i < 3; i++ {
        if mode == 0 && i == 1 {
            p = &y
            break
        }
        if mode == 1 && i == 1 {
            p = &z
            continue
        }
        if mode == 2 && i == 1 {
            p = &y
            return "early:${*p}"
        }
        if i == 1 {
            p = &y
        }
    }
    await Task.Yield()
    return "done:${*p}"
}

async func expressionNonCompletingBranches(flag bool, nested bool) Task[string] {
    var x = 10
    var y = 20
    var z = 30
    var p = &x
    try {
        p = flag ? ({
            throw InvalidOperationException("boom")
        }) : &y
    } catch (InvalidOperationException) {
    }
    let afterCatch = *p
    try {
        p = nested ? (flag ? ({
            throw InvalidOperationException("nested")
        }) : p) : &z
    } catch (InvalidOperationException) {
    }
    await Task.Yield()
    return "${afterCatch}:${*p}"
}

async func nonCompletingDeclConditional(a bool, b bool) Task[string] {
    var x = 11
    var y = 22
    var p = a ? (b ? ({
        return "early"
    }) : &x) : &y
    await Task.Yield()
    return "${*p}"
}

Console.WriteLine("${hoistedDependsOnNonCrossingNative(false).GetAwaiter().GetResult()}:${hoistedDependsOnNonCrossingNative(true).GetAwaiter().GetResult()}")
Console.WriteLine(nonCrossingNativeDependsOnHoisted(false).GetAwaiter().GetResult())
Console.WriteLine(nonCrossingNativeDependsOnHoisted(true).GetAwaiter().GetResult())
Console.WriteLine(hoistedAliasesOverwrittenVarRef().GetAwaiter().GetResult())
Console.WriteLine(blockResultAliasDeclAndReseat(false, false).GetAwaiter().GetResult())
Console.WriteLine(blockResultAliasDeclAndReseat(true, true).GetAwaiter().GetResult())
Console.WriteLine(cyclicBlockResultAlias(false).GetAwaiter().GetResult())
Console.WriteLine(cyclicBlockResultAlias(true).GetAwaiter().GetResult())
Console.WriteLine(statementNonCompletingBranches(0).GetAwaiter().GetResult())
Console.WriteLine(statementNonCompletingBranches(1).GetAwaiter().GetResult())
Console.WriteLine(statementNonCompletingBranches(2).GetAwaiter().GetResult())
Console.WriteLine(expressionNonCompletingBranches(true, false).GetAwaiter().GetResult())
Console.WriteLine(expressionNonCompletingBranches(false, true).GetAwaiter().GetResult())
Console.WriteLine(expressionNonCompletingBranches(true, true).GetAwaiter().GetResult())
Console.WriteLine("${nonCompletingDeclConditional(true, true).GetAwaiter().GetResult()}:${nonCompletingDeclConditional(true, false).GetAwaiter().GetResult()}:${nonCompletingDeclConditional(false, false).GetAwaiter().GetResult()}")`, "NativeRefBlockAndNonCompleting6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            "10:77\n1:100:100\n77:100:100\n15:22\n10:10\n20:30\n10:10\n20:10\ndone:77\ndone:99\nearly:77\n10:30\n20:20\n10:10\nearly:11:22\n",
            fixture.Run(dll)
        )
    }

    @Fact
    func LoopVarRefAndPointerCycle_VerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package LoopVarRefPointerCycle6182
import System
import System.Threading.Tasks

async func loopVarRefAndPointerCycleOverwrittenBeforeAwait() Task[string] {
    var arr = []int32{10, 20, 30}
    var p = &arr[0]
    var first = 0
    for var i = 0; i < 2; i++ {
        var idx = i
        var ref alias = *p
        if i == 0 {
            p = &alias
            first = *p
        }
        p = &arr[idx]
    }
    await Task.Yield()
    return "${first}:${*p}"
}

async func cyclicNativeAliasesWriteThrough(flag bool) Task[string] {
    var a = 1
    var b = 50
    var p = &a
    var q = &b
    var ref ra = *p
    var ref rb = *q
    if false {
        p = &ra
        q = &rb
        p = q
        q = p
    }
    ra = rb
    let stored = (ra = rb)
    rb = 77
    if flag {
        p = &b
    }
    await Task.Yield()
    return "${a}:${b}:${stored}:${*p}"
}

async func loopVarRefConditionalInitInPointerCycle() Task[string] {
    var arr = []int32{10, 20, 30}
    var p = &arr[0]
    var results = ""
    for var i = 0; i < 2; i++ {
        var idx = i
        var ref alias = (i == 0 ? *p : arr[2])
        if false {
            p = &alias
        }
        results += "${alias}:"
        p = &arr[idx + 1]
    }
    await Task.Yield()
    return "${results}${*p}"
}

Console.WriteLine(loopVarRefAndPointerCycleOverwrittenBeforeAwait().GetAwaiter().GetResult())
Console.WriteLine(cyclicNativeAliasesWriteThrough(false).GetAwaiter().GetResult())
Console.WriteLine(cyclicNativeAliasesWriteThrough(true).GetAwaiter().GetResult())
Console.WriteLine(loopVarRefConditionalInitInPointerCycle().GetAwaiter().GetResult())`, "LoopVarRefPointerCycle6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:20\n50:77:50:50\n50:77:50:77\n10:30:30\n", fixture.Run(dll))

        let (code, output) = fixture.TryCompile(`package LoopVarRefPointerCycleReject6182
import System.Threading.Tasks

async func bad(takeAlias bool) Task[int32] {
    var arr = []int32{10, 20, 30}
    var p = &arr[0]
    for var i = 0; i < 2; i++ {
        var idx = i
        var ref alias = *p
        p = &arr[idx]
        if takeAlias {
            p = &alias
        }
    }
    await Task.Yield()
    return *p
}`, "LoopVarRefPointerCycleReject6182", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0258:", output, StringComparison.Ordinal)
    }

    @Fact
    func NestedPointerAssignments_SingleEvaluationAndSnapshot_VerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NestedAssign6182
import System
import System.Threading.Tasks

func nextIndex(ref calls int32, value int32) int32 {
    calls++
    return value
}

async func run(flag bool) Task[string] {
    var arr = []int32{10, 20, 30}
    var x = 1
    var y = 77
    var z = 99
    var calls = 0
    var p = &x
    var q = &z
    p = (p = &y)
    q = (p = &arr[nextIndex(&calls, 1)])
    p = &arr[nextIndex(&calls, 2)]
    var r = flag ? (p = &z) : &x
    var s = &y
    if false {
        p = s
        s = p
    }
    s = (p = q)
    p = &*(q = &y)
    s = &*(p = &arr[nextIndex(&calls, 2)])
    await Task.Yield()
    return "${*p}:${*q}:${*r}:${*s}:${calls}"
}

Console.WriteLine(run(false).GetAwaiter().GetResult())
Console.WriteLine(run(true).GetAwaiter().GetResult())`, "NestedAssign6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("30:77:1:30:3\n30:77:99:30:3\n", fixture.Run(dll))
    }

    @Fact
    func NonCrossingOpaqueRefIndex_UsedAsValue_PreservesNativeAliasAndVerifies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NonCrossingRefIndex6182
import System
import System.Threading.Tasks

func at(xs []int32, i int32) ref int32 {
    return ref xs[i]
}

class Cell {
    var Value int32
    init(value int32) {
        Value = value
    }
}

func atCell(cells []Cell, i int32) ref Cell {
    return ref cells[i]
}

func atArr(arrs [][]int32, i int32) ref []int32 {
    return ref arrs[i]
}

struct Pair {
    var Value int32
}

async func run(flag bool) Task[string] {
    var indices = []int32{1, 2}
    var values = []int32{10, 20, 30}
    var ref index = at(indices, 0)
    var p = &values[index]
    if flag {
        p = &values[2]
    }
    var cells = []Cell{Cell(44)}
    var ref owner = atCell(cells, 0)
    var cp = &owner.Value
    var arrs = [][]int32{[]int32{5, 6}}
    var ref arrAlias = atArr(arrs, 0)
    var ap = &arrAlias[1]
    var pair = Pair{Value: 88}
    var pair2 = Pair{Value: 99}
    var ref structAlias = pair
    var sp = &structAlias.Value
    let sv = *sp
    sp = &pair2.Value
    await Task.Yield()
    return "${*p}:${*cp}:${*ap}:${sv}:${*sp}"
}

Console.WriteLine("${run(false).GetAwaiter().GetResult()}:${run(true).GetAwaiter().GetResult()}")`, "NonCrossingRefIndex6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("20:44:6:88:99:30:44:6:88:99\n", fixture.Run(dll))
    }

    @Fact
    func ReconstructedNativeRefAlias_FieldAndIndexAssignments_TargetInitializedStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NativeAliasFieldIndexWrite6182
import System
import System.Collections.Generic
import System.Threading.Tasks

struct Box {
    var Value int32
}

class Node {
    var Value int32
    init(value int32) {
        Value = value
    }
}

async func runStatementAliases() Task[string] {
    var b = Box{Value: 10}
    var b2 = Box{Value: 2}
    var ref boxAlias = b
    var bp = &boxAlias
    boxAlias.Value = 77
    boxAlias.Value += 3
    let bPre = (*bp).Value
    bp = &b2

    var n = Node(5)
    var n2 = Node(6)
    var ref nodeAlias = n
    var np = &nodeAlias
    nodeAlias.Value = 88
    let nPre = (*np).Value
    np = &n2

    var arr = []int32{1, 2}
    var arr2 = []int32{3, 4}
    var ref arrAlias = arr
    var ap = &arrAlias
    arrAlias[0] = 99
    let aPre = (*ap)[0]
    ap = &arr2

    var list = List[int32]{10, 20}
    var list2 = List[int32]{30, 40}
    var ref listAlias = list
    var lp = &listAlias
    listAlias[1] = 55
    let lPre = (*lp)[1]
    lp = &list2

    await Task.Yield()
    return "${bPre}:${b.Value}:${(*bp).Value}:${nPre}:${n.Value}:${(*np).Value}:${aPre}:${arr[0]}:${(*ap)[0]}:${lPre}:${list[1]}:${(*lp)[1]}"
}

async func runBlockAliases() Task[string] {
    var b = Box{Value: 10}
    var bp = ({
        var ref boxAlias = b
        boxAlias.Value = 77
        boxAlias.Value += 3
        let r = &boxAlias
        r
    })
    var n = Node(5)
    var np = ({
        var ref nodeAlias = n
        nodeAlias.Value = 88
        let r = &nodeAlias
        r
    })
    var arr = []int32{1, 2}
    var ap = ({
        var ref arrAlias = arr
        arrAlias[0] = 99
        let r = &arrAlias
        r
    })
    var list = List[int32]{10, 20}
    var lp = ({
        var ref listAlias = list
        listAlias[1] = 55
        let r = &listAlias
        r
    })
    await Task.Yield()
    return "${b.Value}:${(*bp).Value}:${n.Value}:${(*np).Value}:${arr[0]}:${(*ap)[0]}:${list[1]}:${(*lp)[1]}"
}

Console.WriteLine("${runStatementAliases().GetAwaiter().GetResult()}|${runBlockAliases().GetAwaiter().GetResult()}")`, "NativeAliasFieldIndexWrite6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("80:80:2:88:88:6:99:99:3:55:55:40|80:80:88:88:99:99:55:55\n", fixture.Run(dll))
    }

    @Fact
    func OpaqueRefDependency_OverwrittenBeforeAwait_PreservesNativeAliasAndVerifies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package OpaqueRefDepBeforeAwait6182
import System
import System.Threading.Tasks

struct Pair {
    var Value int32
}

func at(xs []int32, i int32) ref int32 {
    return ref xs[i]
}

func atPair(ps []Pair, i int32) ref Pair {
    return ref ps[i]
}

async func straightReseat() Task[string] {
    var arr = []int32{10, 20}
    var y = 77
    var ref alias = at(arr, 0)
    var p = &alias
    let pre = *p
    p = &y
    await Task.Yield()
    return "${pre}:${*p}"
}

async func conditionalReseat(flag bool) Task[string] {
    var arr = []int32{11, 22}
    var y = 33
    var z = 44
    var ref alias = at(arr, 1)
    var p = &alias
    let pre = *p
    if flag {
        p = &y
    } else {
        p = &z
    }
    await Task.Yield()
    return "${pre}:${*p}"
}

async func structFieldAndChainReseat() Task[string] {
    var pairs = []Pair{Pair{Value: 55}}
    var y = 66
    var ref pairAlias = atPair(pairs, 0)
    var pp = &pairAlias.Value
    let prePair = *pp
    pp = &y
    var arr = []int32{15}
    var ref a1 = at(arr, 0)
    var ref a2 = a1
    var cp = &a2
    let preChain = *cp
    cp = &y
    var ap = &y
    ap = &a1
    let preAssign = *ap
    ap = &y
    await Task.Yield()
    return "${prePair}:${*pp}:${preChain}:${*cp}:${preAssign}:${*ap}"
}

Console.WriteLine(
    "${straightReseat().GetAwaiter().GetResult()}:${conditionalReseat(true).GetAwaiter().GetResult()}:${conditionalReseat(false).GetAwaiter().GetResult()}:${structFieldAndChainReseat().GetAwaiter().GetResult()}"
)`, "OpaqueRefDepBeforeAwait6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:77:22:33:22:44:55:66:15:66:15:66\n", fixture.Run(dll))
        let (_, output) = fixture.TryCompile(`package OpaqueRefDepSurvives6182
import System
import System.Threading.Tasks

func at(xs []int32, i int32) ref int32 {
    return ref xs[i]
}

async func bad() Task[int32] {
    var arr = []int32{10, 20}
    var ref alias = at(arr, 0)
    var p = &alias
    await Task.Yield()
    return *p
}`, "OpaqueRefDepSurvives6182", executable: false)
        Assert.Contains("error GS0258:", output, StringComparison.Ordinal)
    }

    @Fact
    func DeadBlockExpressionOpaqueAlias_DoesNotReconstructAcrossAwait() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package DeadBlockOpaqueAlias6182
import System
import System.Threading.Tasks

func at(xs []int32, i int32) ref int32 {
    return ref xs[i]
}

async func run(flag bool) Task[string] {
    var arr = []int32{10, 20}
    var y = 77
    var z = 88
    var p = ({
        var ref alias = at(arr, 0)
        var r = &alias
        r = &y
        r
    })
    var q = ({
        var ref alias2 = at(arr, 1)
        var r2 = &alias2
        let pre = *r2
        if flag {
            r2 = &y
        } else {
            r2 = &z
        }
        r2
    })
    await Task.Yield()
    return "${*p}:${*q}"
}

Console.WriteLine("${run(true).GetAwaiter().GetResult()}|${run(false).GetAwaiter().GetResult()}")`, "DeadBlockOpaqueAlias6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("77:77|77:88\n", fixture.Run(dll))

        let (code, output) = fixture.TryCompile(`package LiveBlockOpaqueAliasReject6182
import System.Threading.Tasks

func at(xs []int32, i int32) ref int32 {
    return ref xs[i]
}

async func bad() Task[int32] {
    var arr = []int32{10, 20}
    var p = ({
        var ref alias = at(arr, 0)
        var r = &alias
        r
    })
    await Task.Yield()
    return *p
}`, "LiveBlockOpaqueAliasReject6182", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(
            output.Contains("error GS0258:", StringComparison.Ordinal) || output.Contains(
                "error GS9998:",
                StringComparison.Ordinal
            ),
            output
        )
    }

    @Fact
    func NullRefAliasCondition_InSelfConditionalReseat_StillThrowsNullReferenceException() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NullRefCondSelfReseat6182
import System
import System.Runtime.CompilerServices
import System.Threading.Tasks

async func run() Task[string] {
    var x = 10
    var p = &x
    var ref flag = Unsafe.NullRef[bool]()
    var threw = false
    try {
        p = flag ? p : p
    } catch (NullReferenceException) {
        threw = true
    }
    await Task.Yield()
    return "${threw}:${*p}"
}

Console.WriteLine(run().GetAwaiter().GetResult())`, "NullRefCondSelfReseat6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("True:10\n", fixture.Run(dll))
    }

    @Fact
    func CrossTypeCycleOrdering_SinkComponentHoistedFirst_SnapshotsTarget() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CrossTypeCycleOrder6182
import System
import System.Threading.Tasks

struct Pair {
    var A int32
    var B int32
}

async func run(flag bool) Task[string] {
    var s1 = Pair{A: 10, B: 20}
    var s2 = Pair{A: 99, B: 88}
    var x = 1
    var y = 2
    var r = &x
    var t = &y
    if false {
        r = t
        t = r
    }
    var p = &s1
    var q = &s2
    if false {
        p = q
        q = p
    }
    r = &((*p).A)
    if flag {
        p = &s2
    }
    await Task.Yield()
    return "${*r}:${*t}:${(*p).A}:${(*q).B}"
}

Console.WriteLine("${run(true).GetAwaiter().GetResult()}|${run(false).GetAwaiter().GetResult()}")`, "CrossTypeCycleOrder6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:2:99:88|10:2:10:88\n", fixture.Run(dll))
    }

    @Fact
    func ConditionalAddressSelfAlias_PreservesActiveTargetAcrossAwait() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package CondAddrSelfAlias6182
import System
import System.Threading.Tasks

async func run(keep bool) Task[int32] {
    var x = 10
    var y = 77
    var p = &x
    p = &(keep ? *p : y)
    await Task.Yield()
    return *p
}

Console.WriteLine("${run(true).GetAwaiter().GetResult()}:${run(false).GetAwaiter().GetResult()}")`, "CondAddrSelfAlias6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:77\n", fixture.Run(dll))
    }

    @Fact
    func BlockPrefixBeforeSelfAndSharedAlias_LiftsPrefixAndPreservesTarget() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package BlockPrefixSelfSharedAlias6182
import System
import System.Threading.Tasks

async func run(keep bool) Task[string] {
    var x = 10
    var y = 77
    var z = 99
    var log = ""
    var p = &x
    p = &({
        log += "1:"
        *p
    })
    p = keep ? &({
        log += "2:"
        *p
    }) : &y
    var q = &z
    if false {
        p = q
        q = p
    }
    var r = &z
    r = &({
        log += "3:"
        *q
    })
    var s = &z
    s = &({
        log += "4:"
        *p
    })
    await Task.Yield()
    return "${log}${*p}:${*r}:${*s}"
}

Console.WriteLine("${run(true).GetAwaiter().GetResult()}|${run(false).GetAwaiter().GetResult()}")`, "BlockPrefixSelfSharedAlias6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("1:2:3:4:10:99:10|1:3:4:77:99:77\n", fixture.Run(dll))
    }

    @Fact
    func DownstreamSingleDefinitionPointer_AfterPointerAliasCycle_VerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package DownstreamSingleDefAfterCycle6182
import System
import System.Threading.Tasks

async func run(chooseSecond bool) Task[string] {
    var x = 10
    var y = 77
    var p = &x
    if chooseSecond {
        p = &y
    }
    var ref alias = *p
    if false {
        p = &alias
    }
    var q = &alias
    var s = q
    let pre = *s
    s = &x
    await Task.Yield()
    return "${pre}:${*s}"
}

Console.WriteLine("${run(false).GetAwaiter().GetResult()}|${run(true).GetAwaiter().GetResult()}")`, "DownstreamSingleDefAfterCycle6182", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("10:10|77:10\n", fixture.Run(dll))
    }

    @Fact
    func ManagedPointerDefault_EmitAndExecute_WithStrictILVerify() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let templateDll = fixture.Compile(`package Template6182
import System
Console.WriteLine("ok")`, "Template6182", executable: true)
        let source = `package ManagedDefaultEmit6182
import System
import System.Threading.Tasks

async func run(mode int32) Task[string] {
    var x = 42
    var dummy = 0
    var p = &dummy
    var q = p
    var ignored = (p = &dummy)
    if mode == 1 {
        p = &x
    }
    if mode == 2 {
        q = &x
    }
    await Task.Yield()
    var pVal = "null"
    try {
        pVal = (*p).ToString()
    } catch (NullReferenceException) {
        pVal = "nre"
    }
    var qVal = "null"
    try {
        qVal = (*q).ToString()
    } catch (NullReferenceException) {
        qVal = "nre"
    }
    return string.Concat(pVal, ":", qVal)
}

Console.WriteLine(run(0).GetAwaiter().GetResult())
Console.WriteLine(run(1).GetAwaiter().GetResult())
Console.WriteLine(run(2).GetAwaiter().GetResult())`
        let refs = ReferenceResolver.Default()
        let comp = GSharp.Core.CodeAnalysis.Compilation.Compilation(refs, SyntaxTree.Parse(SourceText.From(source)))
        let bound = comp.BoundProgram
        Assert.False(bound.Diagnostics.Any((d Diagnostic) -> d.IsError))
        let patcher = DummyAddressToDefaultRewriter()
        let patchedFunctions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
        for pair in bound.Functions {
            patchedFunctions.Add(pair.Key, cast[BoundBlockStatement](patcher.RewriteStatement(pair.Value)))
        }
        let patchedProgram = BoundProgram(
            bound.EntryPointPackage,
            bound.Packages,
            bound.Diagnostics,
            patchedFunctions.ToImmutable(),
            bound.EntryPoint,
            bound.Statement
        )
        let asyncResult = AsyncStateMachineRewriter.Rewrite(patchedProgram, refs)
        let dll = Path.Combine(fixture.Directory, "ManagedDefaultEmit6182.dll")
        File.Copy(
            Path.ChangeExtension(templateDll, ".runtimeconfig.json"),
            Path.ChangeExtension(dll, ".runtimeconfig.json"),
            overwrite: true
        )
        using let peStream = File.Create(dll)
        ReflectionMetadataEmitter.Emit(
            asyncResult.Program,
            peStream,
            refs,
            "ManagedDefaultEmit6182",
            metadataOnly: false,
            asyncRewriteResult: asyncResult
        )
        peStream.Dispose()
        IlVerifier.Verify(dll)
        Assert.Equal("nre:nre\n42:nre\nnre:42\n", fixture.Run(dll))
    }

    private class DummyAddressToDefaultRewriter : BoundTreeRewriter {
        protected override func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
            if node.Operand is BoundVariableExpression{Variable: LocalVariableSymbol v} && v.Name == "dummy" {
                return BoundDefaultExpression(node.Syntax, node.Type)
            }
            return base.RewriteAddressOfExpression(node)
        }
    }
}
