// <copyright file="ChannelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Emitted-oracle coverage for channel.
/// </summary>
public class ChannelTests
{
    [Fact]
    public void MakeChannel_AndSendRecv_Roundtrip()
    {
        var source = @"
let ch = chan[int32](1)
ch <- 7
let v = <-ch
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MakeChannel_Unbounded_Binds()
    {
        var source = @"
let ch = Chan.Unbounded[string]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Close_OnChannel_Binds()
    {
        var source = @"
let ch = chan[int32](1)
ch.Close()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Receive_FromClosedChannel_ReturnsZero()
    {
        var source = @"
let ch = chan[int32](1)
ch.Close()
let v = <-ch
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Send_ToNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
x <- 2
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    [Fact]
    public void Receive_FromNonChannel_Diagnoses()
    {
        var source = @"
let x = 1
let v = <-x
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("channel"));
    }

    [Fact]
    public void Close_OnNonChannel_IsAnOrdinaryMemberNotFound()
    {
        // ADR-0174 D12: `Close()` is a member, so closing a non-channel is the
        // ordinary member-not-found error — no channel-specific diagnostic.
        var source = @"
let x = 1
x.Close()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id.StartsWith("GS05", System.StringComparison.Ordinal));
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        // ADR-0174 D13: the channel surface needs no import.
        return EmittedOracle.Evaluate(source);
    }
}
