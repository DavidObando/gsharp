// <copyright file="Adr0174ChanRuntimeSmokeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import GSharp.Tests
import Xunit

/// ADR-0174 Phase 1 gate: `gsi` executes emitted IL in an in-memory
/// load context and must resolve `Gsharp.Runtime.Channels` there. These
/// tests reach the C# runtime from G# through its ordinary imported-type
/// surface (no compiler support for `chan[T]` yet — that is Phase 2), so
/// they pin only the reference plumbing: the driver probe finds the bundled
/// assembly, a single-shot submission binds and runs against it, and a
/// channel constructed in one REPL cell is usable from the next.
open class Adr0174ChanRuntimeSmokeTests {
    @Fact
    func Chan_ConstructSendReceive_FromGsharp_ThroughEmittedExecution() {
        let result = EmittedOracle.Evaluate(`import Gsharp.Concurrency

func run() int32 {
    var ch = Chan[int32](2)
    var total = 0
    if ch.Capacity == 2 {
        total = total + 1000
    }

    ch.TrySend(40)
    ch.TrySend(2)
    total = total + ch.Length() * 100          // + 200

    var v = 0
    var ok = false
    if ch.TryReceive(out v, out ok) && ok {
        total = total + v                      // + 40
    }
    if ch.TryReceive(out v, out ok) && ok {
        total = total + v                      // + 2
    }

    // Closed and drained: (zero, false) — no exception.
    ch.Close()
    if ch.TryReceive(out v, out ok) && !ok && v == 0 && ch.IsClosed {
        total = total + 10000
    }

    return total
}

run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11242, result.Value)
    }

    @Fact
    func Rendezvous_And_Unbounded_Factories_FromGsharp() {
        let result = EmittedOracle.Evaluate(`import Gsharp.Concurrency

func run() int32 {
    var rendezvous = Chan[int32]()
    var unbounded = Chan.Unbounded[int32]()
    var total = 0
    if rendezvous.Capacity == 0 && !rendezvous.TrySend(1) {
        total = total + 1
    }
    if unbounded.IsUnbounded {
        for i in 0 ... 1000 {
            unbounded.TrySend(i)
        }
        total = total + unbounded.Length()
    }
    return total
}

run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1001, result.Value)
    }

    @Fact
    func Chan_ConstructedInOneCell_IsUsableFromTheNext() {
        using let engine = EmittedSessionEngine()
        let first = engine.Evaluate("import Gsharp.Concurrency\nvar shared = Chan[int32](1)")
        Assert.False(first.HasError, string.Join("; ", first.Diagnostics))
        let second = engine.Evaluate("import Gsharp.Concurrency\nshared.TrySend(7)")
        Assert.False(second.HasError, string.Join("; ", second.Diagnostics))
        let third = engine.Evaluate(`import Gsharp.Concurrency
var got = 0
var ok = false
shared.TryReceive(out got, out ok)
got`)
        Assert.False(third.HasError, string.Join("; ", third.Diagnostics))
        Assert.Equal(7, third.Value)
    }
}
