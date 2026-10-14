// <copyright file="Adr0174ChannelMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0174 D12: channel members are ordinary members, not built-ins. A
/// constructed channel is a `Chan[T]` and exposes `Length()`,
/// `Capacity`, `IsClosed` and `Dispose` (so `using let`
/// closes it); a `chan[T]` handle exposes only what
/// `Channel<T>` has, so `Length()` on it is the ordinary
/// member-not-found error; `Close()` binds on a channel or an
/// `out chan[T]` writer and is not a member of an `in chan[T]` reader.
open class Adr0174ChannelMembersEmitTests {
    @Fact
    func Length_OnAChanTHandle_IsAnOrdinaryMemberNotFound() {
        let (diagnostics, _) = Bind(`package P
func f(ch chan[int32]) int32 {
    return ch.Length()
}`)
        Assert.NotEmpty(diagnostics)
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Contains("Length", d.Message))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0566")
    }

    @Fact
    func UsingLet_ClosesTheChannel_AtBlockExit() {
        let result = EmittedOracle.Evaluate(`package P0174UsingLet
func flag(b bool) int32 {
    if b {
        return 1
    }
    return 0
}
let ch = chan[int32](1)
var closedInside = false
{
    using let handle = ch
    closedInside = ch.IsClosed
}
flag(closedInside) * 10 + flag(ch.IsClosed)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func Close_OnAnOutHandle_ClosesTheChannel() {
        let result = EmittedOracle.Evaluate(`package P0174CloseOut
func stop(w out chan[int32]) {
    w.Close()
}
let ch = chan[int32](1)
stop(ch)
let (v, ok) = <-ch
if ok { 1 } else { 0 }`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Close_OnAnInHandle_IsNotAMember() {
        let (diagnostics, _) = Bind(`package P
func stop(r in chan[int32]) {
    r.Close()
}`)
        Assert.NotEmpty(diagnostics)
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Contains("Close", d.Message))
    }

    shared {
        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }
    }
}
