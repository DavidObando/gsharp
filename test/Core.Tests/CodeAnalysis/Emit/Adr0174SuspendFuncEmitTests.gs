// <copyright file="Adr0174SuspendFuncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading.Tasks
import Xunit

/// ADR-0174 D4 through real emitted execution and metadata: a
/// `suspend func f() R` is a MethodDef returning `ValueTask<R>`
/// (`ValueTask` for void) carrying `[Gsharp.Concurrency.Suspending]`,
/// whose state machine uses the pooling ValueTask builder; G# callers see
/// `R`, and the whole program behaves as if every call were a plain call.
/// @remarks Discrimination witness (ADR-0154): a mutant that leaves the default
/// `AsyncValueTaskMethodBuilder` in place for suspending functions
/// breaks (cref:StateMachine_UsesThePoolingBuilder); a mutant that
/// skips the attribute breaks (cref:MethodDef_ReturnsValueTask_AndIsLabelledSuspending).
open class Adr0174SuspendFuncEmitTests {
    @Fact
    func SuspendFuncs_ComposeAndRun() {
        let result = EmittedOracle.Evaluate(`package P0174Suspend

suspend func take(ch in chan[int32]) int32 {
    return <-ch
}

suspend func sum(ch in chan[int32], n int32) int32 {
    var s = 0
    for i in 0 ... n {
        s = s + take(ch)
    }
    return s
}

suspend func fill(ch out chan[int32], n int32) {
    for i in 1 ... n + 1 {
        ch <- i
    }
}

let ch = chan[int32](8)
fill(ch, 4)
sum(ch, 4)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func ExplicitAwait_OnASuspendingCall_RunsLikeTheImplicitOne() {
        let result = EmittedOracle.Evaluate(`package P0174ExplicitAwait
suspend func twice(ch in chan[int32]) int32 {
    let v = <-ch
    return v * 2
}
suspend func run() int32 {
    let ch = chan[int32](1)
    ch <- 21
    let a = await twice(ch)
    ch <- 5
    let b = twice(ch)
    return a + b
}
run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(52, result.Value)
    }

    @Fact
    func BoundaryCaller_BlocksThroughTheBridge_AndWarns() {
        let result = EmittedOracle.Evaluate(`package P0174SuspendBridge

suspend func take(ch in chan[int32]) int32 {
    return <-ch
}

open class Reader {
    open func Read(ch chan[int32]) int32 {
        return take(ch) * 10
    }
}

let ch = chan[int32](1)
ch <- 7
Reader().Read(ch)`)
        let warning = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0558", warning.Id)
        Assert.Equal(70, result.Value)
    }

    @Fact
    func MethodDef_ReturnsValueTask_AndIsLabelledSuspending() {
        let result = EmittedOracle.Evaluate(`package P0174SuspendMeta

suspend func take(ch in chan[int32]) int32 {
    return <-ch
}

suspend func fill(ch out chan[int32]) {
    ch <- 5
}

let ch = chan[int32](1)
fill(ch)
take(ch)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        let take = FindMethod(assembly, "take")
        let fill = FindMethod(assembly, "fill")
        Assert.Equal(typeof(ValueTask[int32]), take.ReturnType)
        Assert.Equal(typeof(ValueTask), fill.ReturnType)
        Assert.Contains(
            take.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
        )
        Assert.Contains(
            fill.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
        )
    }

    @Fact
    func StateMachine_UsesThePoolingBuilder() {
        let result = EmittedOracle.Evaluate(`package P0174SuspendPool

suspend func take(ch in chan[int32]) int32 {
    return <-ch
}

let ch = chan[int32](1)
ch <- 9
take(ch)`)
        Assert.Empty(result.Diagnostics)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        let builderFields = assembly
            .GetTypes()
            .SelectMany(
            func (t Type) IEnumerable[FieldInfo] {
                return t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            }
        )
            .Where((f FieldInfo) -> f.FieldType.Name.Contains("MethodBuilder", StringComparison.Ordinal))
            .ToArray()
        let pooling = Assert.Single(builderFields)
        Assert.Equal("PoolingAsyncValueTaskMethodBuilder`1", pooling.FieldType.Name)
        Assert.Equal(typeof(int32), pooling.FieldType.GetGenericArguments()[0])
    }

    @Fact
    func AsyncFuncs_StillUseTheTaskBuilder() {
        let result = EmittedOracle.Evaluate(`package P0174AsyncStillTask
import System.Threading.Tasks

async func compute() int32 {
    await Task.Yield()
    return 3
}

compute().Result`)
        Assert.Empty(result.Diagnostics)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        let compute = FindMethod(assembly, "compute")
        Assert.Equal(typeof(Task[int32]), compute.ReturnType)
        Assert.DoesNotContain(
            compute.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
        )
    }

    @Fact
    func ParkedSuspendFuncs_DoNotHoldThreads() {
        let result = EmittedOracle.Evaluate(`package P0174SuspendParked
import System.Collections.Generic
import System.Threading.Tasks

suspend func waitOne(ch chan[int32]) int32 {
    return <-ch
}

async func start(ch chan[int32]) int32 {
    return waitOne(ch)
}

let ch = chan[int32]()
let count = 256
var pending = List[Task[int32]]()
for i in 0 ... count {
    pending.Add(start(ch))
}
for i in 0 ... count {
    ch <- i
}
var sum = 0
for t in pending {
    sum = sum + t.Result
}
sum`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(256 * 255 / 2, result.Value)
    }

    shared {
        private func FindMethod(assembly Assembly, name string) MethodInfo -> assembly
            .GetTypes()
            .SelectMany(
            func (t Type) IEnumerable[MethodInfo] {
                return t.GetMethods(
                    BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            }
        )
            .Single((m MethodInfo) -> m.Name == name)
    }
}
