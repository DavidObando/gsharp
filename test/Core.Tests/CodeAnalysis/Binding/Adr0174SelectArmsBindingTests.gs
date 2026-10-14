// <copyright file="Adr0174SelectArmsBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0174 D8, the diagnostics guarding the new `select` arms: a
/// `when` guard must be a `bool` (GS0556); `case cancelled` must
/// have an ambient context to observe or it is silently dead (GS0557); and a
/// select that both sends to and receives from one channel can complete by
/// talking to itself, which is worth saying out loud (GS0564).
/// @remarks Discrimination witness (ADR-0154): GS0557 is decided after suspension
/// inference, not at bind time, because whether a function carries a context is
/// only known once the fixed point has run. A mutant that reports it from the
/// binder — "no enclosing `scope`, therefore no context" — breaks
/// (cref:CancelledArm_InsideAFunction_NeedsNoScope) and
/// (cref:CancelledArm_WithADeclaredContextParameter_IsAccepted), both of
/// which have a context that arrives through a parameter rather than a block.
/// A mutant that compares bound operands instead of their variable symbols
/// breaks (cref:SendAndReceiveOnOneChannel_ReportsGS0564), because a
/// receive operand is wrapped in the `in chan[T]` view conversion and a
/// send operand is not.
open class Adr0174SelectArmsBindingTests {
    @Fact
    func NonBooleanGuard_ReportsGS0556() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
select {
case <-ch when 1 { }
default { }
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0556")
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity)
        Assert.Contains("'int32'", diagnostic.Message)
    }

    @Fact
    func BooleanGuard_IsAccepted() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
var ready = true
select {
case <-ch when ready { }
default { }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func Guard_CannotSeeTheArmsOwnBinding() {
        // The guard decides whether the arm is registered at all, long before a
        // value arrives, so the binding it would introduce is not in scope.
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
scope {
    select {
    case let v = <-ch when v > 0 { }
    }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125" && d.Message.Contains("'v'"))
    }

    @Fact
    func CancelledArm_AtTopLevelWithNoScope_ReportsGS0557() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
select {
case cancelled { }
case <-ch { }
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity)
    }

    @Fact
    func DirectSelectWaiterAddCancelled_IsNotAnAmbientCancelledArm() {
        let diagnostics = Compile(`package P
import System.Threading
import Gsharp.Concurrency
func register() {
    let waiter = SelectWaiter.Rent(1, CancellationToken.None)
    waiter.AddCancelled(0)
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func CancelledArm_InsideAScope_IsAccepted() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
scope {
    select {
    case cancelled { }
    case <-ch { }
    }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
    }

    @Fact
    func CancelledArm_InsideAFunction_NeedsNoScope() {
        // The function is inferred suspending, so it carries the caller's
        // context and the arm is live.
        let diagnostics = Compile(`package P
func wait(ch in chan[int32]) int32 {
    select {
    case cancelled { return -1 }
    case let v = <-ch { return v }
    }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
    }

    @Fact
    func CancelledArm_WithADeclaredContextParameter_IsAccepted() {
        // An `open` method is a suspension boundary and never gains a hidden
        // context, but an author who spelled `ctx Context` has said how the
        // context arrives.
        let diagnostics = Compile(`package P
import Gsharp.Concurrency

open class Reader {
    open func Read(ctx Context, ch in chan[int32]) int32 {
        select {
        case cancelled { return -1 }
        case let v = <-ch { return v }
        }
    }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
    }

    @Fact
    func CancelledArm_InABoundaryWithoutAContext_ReportsGS0557() {
        let diagnostics = Compile(`package P
open class Reader {
    open func Read(ch in chan[int32]) int32 {
        select {
        case cancelled { return -1 }
        case let v = <-ch { return v }
        }
    }
}`)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0557")
    }

    @Fact
    func SendAndReceiveOnOneChannel_ReportsGS0564() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
select {
case ch <- 1 { }
case <-ch { }
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0564")
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity)
        Assert.Contains("'ch'", diagnostic.Message)
    }

    @Fact
    func SendAndReceiveOnDifferentChannels_IsSilent() {
        let diagnostics = Compile(`package P
let a = chan[int32](1)
let b = chan[int32](1)
select {
case a <- 1 { }
case <-b { }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0564")
    }

    @Fact
    func TwoReceivesOnOneChannel_IsSilent() {
        // Two receive arms on one channel are odd but harmless: the select
        // cannot satisfy itself that way.
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
select {
case <-ch { }
case let v = <-ch { }
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0564")
    }

    @Fact
    func AwaitArm_OnANonTask_IsNotAwaitable() {
        let diagnostics = Compile(`package P
let ch = chan[int32](1)
let n = 3
select {
case let v = await n { }
case <-ch { }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0133")
    }

    @Fact
    func AwaitArm_BindsTheTasksResultType() {
        let compilation = Compilation(SyntaxTree.Parse(`package P
import System.Threading.Tasks
let ch = chan[int32](1)
let t = Task.FromResult("hello")
select {
case let v = await t { let n = v.Length }
case <-ch { }
}`))
        Assert.DoesNotContain(EmittedOracle.CompileDiagnostics(compilation), (d Diagnostic) -> d.IsError)
    }

    shared {
        private func Compile(source string) ImmutableArray[Diagnostic] -> EmittedOracle.CompileDiagnostics(
            Compilation(SyntaxTree.Parse(source))
        )
    }
}
