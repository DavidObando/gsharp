// <copyright file="Adr0174SelectArmsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// ADR-0174 D8, the arms beyond send and receive: a `when` guard decides
/// once, on entry, whether an arm takes part; `case cancelled` turns the
/// ambient context's cancellation into an arm instead of an unwind; and
/// `case await` lets a `Task` race the channels. Together they replace
/// the Go idioms G# had no spelling for — the nil-channel trick, a
/// `ctx.Done()` arm, and `select` over a future.
/// @remarks Discrimination witnesses (ADR-0154), all three run against the mutants named:
///
/// - A mutant that registers every arm regardless of its guard breaks
/// (cref:FalseGuard_KeepsTheArmOutOfTheSelect): the ready-but-disabled arm wins and the program prints
/// its value instead of taking `default` (observed: `b=9` against the expected `default`).
/// - A mutant whose non-blocking probe ignores the cancelled arm breaks
/// (cref:CancelledArm_BeatsDefault_WhenTheContextIsAlreadyCancelled): an already-cancelled context is a
/// ready arm, so taking `default` over it is the same bug as taking `default` over a ready channel
/// (observed: `default` against the expected `cancelled`).
/// - A mutant that leaves a select's waiter parked on the default context breaks
/// (cref:CancelledArm_InACallee_ObservesTheCallersScope), which then never terminates: the callee's
/// select cannot see the caller's cancellation, so neither arm ever becomes ready.
open class Adr0174SelectArmsEmitTests {
    @Fact
    func FalseGuard_KeepsTheArmOutOfTheSelect() {
        // The channel is ready; the guard is not. G# spells "disable this arm"
        // with `when`, where Go sets the channel variable to nil.
        let result = EmittedOracle.Evaluate(`package P0174ArmGuardOff
func run() string {
    let b = chan[int32](1)
    b <- 9
    select {
    case let v = <-b when false {
        return "b=" + v.ToString()
    }
    default {
        return "default"
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("default", result.Value)
    }

    @Fact
    func TrueGuard_LeavesTheArmInTheSelect() {
        let result = EmittedOracle.Evaluate(`package P0174ArmGuardOn
func run() string {
    let b = chan[int32](1)
    b <- 9
    var enabled = true
    select {
    case let v = <-b when enabled {
        return "b=" + v.ToString()
    }
    default {
        return "default"
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("b=9", result.Value)
    }

    @Fact
    func Guard_IsEvaluatedOnce_OnEntry() {
        // A guard that counted once per probe, or once per reprobe, would run
        // more than once here; the arm it disables never becomes ready, so the
        // select settles on the other one.
        let result = EmittedOracle.Evaluate(`package P0174ArmGuardOnce
var calls = 0

func gate() bool {
    calls = calls + 1
    return false
}

func run() string {
    let a = chan[int32](1)
    let b = chan[int32](1)
    a <- 1
    select {
    case <-b when gate() {
        return "b"
    }
    case <-a {
        return "a calls=" + calls.ToString()
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("a calls=1", result.Value)
    }

    @Fact
    func CancelledArm_IsTakenInsteadOfUnwinding() {
        let result = EmittedOracle.Evaluate(`package P0174ArmCancelled
func run() string {
    var outcome = "none"
    scope {
        let never = chan[int32]()
        ctx.TryCancel()
        select {
        case cancelled {
            outcome = "cancelled"
        }
        case <-never {
            outcome = "never"
        }
        }
    }

    return outcome
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("cancelled", result.Value)
    }

    @Fact
    func CancelledArm_BeatsDefault_WhenTheContextIsAlreadyCancelled() {
        let result = EmittedOracle.Evaluate(`package P0174ArmCancelledDefault
func run() string {
    var outcome = "none"
    scope {
        let never = chan[int32]()
        ctx.TryCancel()
        select {
        case cancelled {
            outcome = "cancelled"
        }
        case <-never {
            outcome = "never"
        }
        default {
            outcome = "default"
        }
        }
    }

    return outcome
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("cancelled", result.Value)
    }

    @Fact
    func WithoutACancelledArm_ACancelledSelectUnwinds() {
        // The contrast that makes the arm meaningful: cancellation is an
        // exception unless the author asked to handle it as an arm.
        let result = EmittedOracle.Evaluate(`package P0174ArmNoCancelled
import System

func run() string {
    var outcome = "none"
    try {
        scope {
            let never = chan[int32]()
            ctx.TryCancel()
            select {
            case <-never {
                outcome = "never"
            }
            }
        }
    } catch (e Exception) {
        outcome = "threw"
    }

    return outcome
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("threw", result.Value)
    }

    @Fact
    func CancelledArm_InACallee_ObservesTheCallersScope() {
        // The callee has no lexical `scope`, so its select is bound against the
        // hidden context parameter the suspension pass hands it. Without that
        // retargeting the select parks on the default token and this never
        // returns.
        let result = EmittedOracle.Evaluate(`package P0174ArmCancelledCallee
func wait(never in chan[int32]) string {
    select {
    case cancelled {
        return "cancelled"
    }
    case <-never {
        return "value"
    }
    }
}

func run() string {
    var outcome = "none"
    scope {
        let never = chan[int32]()
        go { ctx.TryCancel() }
        outcome = wait(never)
    }

    return outcome
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("cancelled", result.Value)
    }

    @Fact
    func AwaitArm_BindsTheTasksResult() {
        let result = EmittedOracle.Evaluate(`package P0174ArmAwaitBind
import System.Threading.Tasks

func run() string {
    let never = chan[int32]()
    let t = Task.FromResult(41)
    select {
    case let v = await t {
        return "task=" + v.ToString()
    }
    case <-never {
        return "never"
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("task=41", result.Value)
    }

    @Fact
    func AwaitArm_WithoutABinding_RunsItsBody() {
        let result = EmittedOracle.Evaluate(`package P0174ArmAwaitDiscard
import System.Threading.Tasks

func run() string {
    let never = chan[int32]()
    let t = Task.Delay(1)
    select {
    case await t {
        return "task"
    }
    case <-never {
        return "never"
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("task", result.Value)
    }

    @Fact
    func AwaitArm_CarriesAUserStructResult() {
        // `Task[T]` is invariant, so a same-compilation result type must travel
        // symbolically for the same reason a channel element does; closing
        // `AddTask` over `object` here would unbox a value that was never boxed
        // (the shape of issue #2965).
        let result = EmittedOracle.Evaluate(`package P0174ArmAwaitStruct
import System.Threading.Tasks

data struct Pair(Value int32)

func run() int32 {
    let never = chan[int32]()
    let t = Task.FromResult(Pair(41))
    select {
    case let p = await t {
        return p.Value
    }
    case <-never {
        return -1
    }
    }
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(41, result.Value)
    }

    @Fact
    func GuardedCancelledArm_IsDisabledLikeAnyOther() {
        let result = EmittedOracle.Evaluate(`package P0174ArmCancelledGuard
func run() string {
    var outcome = "none"
    scope {
        let ready = chan[int32](1)
        ready <- 3
        ctx.TryCancel()
        select {
        case cancelled when false {
            outcome = "cancelled"
        }
        case let v = <-ready {
            outcome = "ready=" + v.ToString()
        }
        }
    }

    return outcome
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("ready=3", result.Value)
    }
}
