// <copyright file="ChannelTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for channel.
open class ChannelTests {
    @Fact
    func MakeChannel_AndSendRecv_Roundtrip() {
        let source = `
let ch = chan[int32](1)
ch <- 7
let v = <-ch
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MakeChannel_Unbounded_Binds() {
        let source = `
let ch = Chan.Unbounded[string]()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Close_OnChannel_Binds() {
        let source = `
let ch = chan[int32](1)
ch.Close()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Receive_FromClosedChannel_ReturnsZero() {
        let source = `
let ch = chan[int32](1)
ch.Close()
let v = <-ch
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Send_ToNonChannel_Diagnoses() {
        let source = `
let x = 1
x <- 2
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("channel"))
    }

    @Fact
    func Receive_FromNonChannel_Diagnoses() {
        let source = `
let x = 1
let v = <-x
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("channel"))
    }

    @Fact
    func Close_OnNonChannel_IsAnOrdinaryMemberNotFound() {
        // ADR-0174 D12: `Close()` is a member, so closing a non-channel is the
        // ordinary member-not-found error — no channel-specific diagnostic.
        let source = `
let x = 1
x.Close()
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id.StartsWith("GS05", StringComparison.Ordinal))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            // ADR-0174 D13: the channel surface needs no import.
            return EmittedOracle.Evaluate(source)
        }
    }
}
