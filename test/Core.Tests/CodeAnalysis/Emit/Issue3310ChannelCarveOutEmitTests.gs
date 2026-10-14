// <copyright file="Issue3310ChannelCarveOutEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3310 / ADR-0159 channel carve-out: `chan[T]` is excluded from
/// the empty-instance zero values (an auto-created channel has no sensible
/// default — buffer size and ownership are the decisions `make`
/// exists to force), so a bare initializer-less channel declaration is
/// rejected with GS0520 at the global and field declaration surfaces. On
/// main these declarations compiled and NRE'd on first use. LOCALS were
/// originally rejected at the declaration too; since issue #3316 they
/// declare freely and are flow-checked at use sites instead (GS0522 — see
/// `Issue3316LocalDefiniteAssignmentTests`).
open class Issue3310ChannelCarveOutEmitTests {
    @Fact
    func BareChannelLocal_DeclarationAlone_NoLongerReportsGS0520() {
        // Issue #3316: the declaration-site error moved to unassigned USE
        // sites for locals. A declared-but-never-used bare channel local is
        // legal (and its slot simply stays null, unobservable).
        let result = EmittedOracle.Evaluate(`package P3310ChanLocal


func run() int32 {
    var c chan[int32]
    return 0
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func BareChannelGlobal_ReportsGS0520() {
        let result = EmittedOracle.Evaluate(`package P3310ChanGlobal


var c chan[int32]
0`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
    }

    @Fact
    func BareChannelInstanceField_ReportsGS0520() {
        let result = EmittedOracle.Evaluate(`package P3310ChanField


class Worker {
    var inbox chan[int32]
}

0`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
    }

    @Fact
    func BareChannelStaticField_ReportsGS0520() {
        let result = EmittedOracle.Evaluate(`package P3310ChanStaticField


class Bus {
    shared {
        var events chan[int32]
    }
}

0`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
    }

    @Fact
    func InitializedChannelLocal_StaysAccepted() {
        // The remedy the diagnostic suggests: explicit `make`.
        let result = EmittedOracle.Evaluate(`package P3310ChanMakeLocal


func run() int32 {
    var c = chan[int32](1)
    c <- 7
    return <-c
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ChannelFieldWithMakeInitializer_StaysAccepted() {
        let result = EmittedOracle.Evaluate(`package P3310ChanFieldInit


class Worker {
    var inbox chan[int32] = chan[int32](1)
    func Ping() int32 {
        inbox <- 5
        return <-inbox
    }
}

func run() int32 {
    var w = Worker()
    return w.Ping()
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(5, result.Value)
    }
}
