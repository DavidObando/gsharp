// <copyright file="DeferStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Phase 7.1 / ADR-0030 — `defer` and shared block-scope cleanup lowering.
open class DeferStatementTests {
    @Fact
    func Defer_SingleDeferRunsAtBlockExit() {
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record("after")
    DeferFixture.Record("before")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("before,after", result.Value)
    }

    @Fact
    func Defer_MultipleDefersRunLifo() {
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record("first")
    defer DeferFixture.Record("second")
    defer DeferFixture.Record("third")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("third,second,first", result.Value)
    }

    @Fact
    func Defer_ArgumentsEvaluateEagerly() {
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    var x = 1
    defer DeferFixture.RecordNumber(x)
    x = 2
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", result.Value)
    }

    @Fact
    func Defer_InstanceReceiverEvaluatesEagerly() {
        // Issue #1635 / ADR-0030: `defer r.Close()` must capture the receiver
        // `r` at the defer point. Reassigning `r` afterwards must not change
        // which instance the deferred call runs against.
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

class Recorder(Name string) {
    func Close() {
        DeferFixture.Record(Name)
    }
}

DeferFixture.Reset()
{
    var r = Recorder("orig")
    defer r.Close()
    r = Recorder("other")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("orig", result.Value)
    }

    @Fact
    func Defer_IndirectCallTargetEvaluatesEagerly() {
        // Issue #1635 / ADR-0030: `defer g()` through a function value must
        // capture the function value at the defer point. Reassigning `g`
        // afterwards must not change which function runs at scope exit.
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    var g = func() { DeferFixture.Record("orig") }
    defer g()
    g = func() { DeferFixture.Record("other") }
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("orig", result.Value)
    }

    @Fact
    func Defer_ReceiverProducedByCallEvaluatesAtDeferPoint() {
        // Issue #1635 / ADR-0030: `defer getX().M()` must evaluate `getX()`
        // eagerly at the defer point, not at scope exit. Observed via
        // side-effect ordering: the "get" event must precede "body", and the
        // deferred "close" event must come last.
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

class Recorder(Name string) {
    func Close() {
        DeferFixture.Record("close-" + Name)
    }
}

func getRecorder() Recorder {
    DeferFixture.Record("get")
    return Recorder("x")
}

DeferFixture.Reset()
{
    defer getRecorder().Close()
    DeferFixture.Record("body")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("get,body,close-x", result.Value)
    }

    @Fact
    func Defer_RunsOnException() {
        let result = Evaluate(`
import System
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
try {
    {
        defer DeferFixture.Record("defer")
        DeferFixture.ThrowNow()
    }
} catch (e Exception) {
    DeferFixture.Record("catch")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("defer,catch", result.Value)
    }

    @Fact
    func Defer_NonCallOperandDiagnoses() {
        let result = Evaluate(`
defer 42
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("'defer'"))
    }

    @Fact
    func Defer_CallWithOutArgument_ReportsGS0460() {
        // Issue #1635 NB-1: a by-ref (ref/out/in) argument's bound value is
        // the ADDRESS of its target storage. Eager capture spilling that
        // address into an ordinary readonly local is not a meaningful by-ref
        // capture, so `defer` on such a call is rejected rather than
        // mis-compiled.
        let result = Evaluate(`
import System
import System.Collections.Generic

var dict = Dictionary[string, int32]()
dict["key"] = 42
var value = 0
defer dict.TryGetValue("key", &value)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0460")
    }

    @Fact
    func Using_DisposeProtectsSubsequentThrowingStatements() {
        let result = Evaluate(`
import System
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
try {
    {
        using let d = DeferFixture.Open("dispose")
        DeferFixture.ThrowNow()
    }
} catch (e Exception) {
    DeferFixture.Record("catch")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("dispose,catch", result.Value)
    }

    @Fact
    func DeferAndUsing_InterleaveInLifoOrder() {
        let result = Evaluate(`
import GSharp.Core.Tests.CodeAnalysis.Binding

DeferFixture.Reset()
{
    defer DeferFixture.Record("defer-1")
    using let u1 = DeferFixture.Open("using-1")
    defer DeferFixture.Record("defer-2")
    using let u2 = DeferFixture.Open("using-2")
    DeferFixture.Record("body")
}
DeferFixture.Snapshot()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("body,using-2,defer-2,using-1,defer-1", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

/// Side-effect helpers exposed to GSharp defer tests.
shared class DeferFixture {
    private class RecordingDisposable : IDisposable {
        private let value string

        init(value string) {
            this.value = value
        }

        func Dispose() -> DeferFixture.Events.Add(value)
    }

    private let Events List[string] = List[string]()

    /// Clears the recorded event log.
    func Reset() -> Events.Clear()

    /// Records one event.
    /// @param value The value to record.
    func Record(value string) -> Events.Add(value)

    /// Records an integer event.
    /// @param value The value to record.
    func RecordNumber(value int32) -> Events.Add(value.ToString())

    /// Gets the recorded events as a comma-separated string.
    /// @returns The current event log.
    func Snapshot() string -> string.Join(",", Events)

    /// Creates a disposable that records an event from (cref:IDisposable.Dispose).
    /// @param value The value to record on disposal.
    /// @returns A disposable event recorder.
    func Open(value string) IDisposable -> RecordingDisposable(value)

    /// Throws a test exception.
    /// @exception InvalidOperationException Always thrown.
    func ThrowNow() {
        throw InvalidOperationException("boom")
    }
}
