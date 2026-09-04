// <copyright file="Issue3304GoVoidOperandSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3304: `go` with a void-returning call operand must also work in an
/// interactive submission (the emitted session engine), not just in a whole
/// program — pre-fix the binder reported GS0124 on the `go` cell.
/// </summary>
public sealed class Issue3304GoVoidOperandSessionTests : IDisposable
{
    private readonly EmittedSessionEngine engine = new();

    public void Dispose() => engine.Dispose();

    [Fact]
    public void GoOnVoidCall_InReplSubmission_RunsAndRendezvouses()
    {
        // The whole rendezvous lives in one submission: a channel hoisted
        // into session state is projected back as its CLR type
        // (System.Threading.Channels.Channel[int32]), not a ChannelTypeSymbol,
        // so a later cell's `<-done` is rejected — a pre-existing
        // cross-submission limitation independent of #3304 (it fails
        // identically for a value-returning goroutine target).
        var cell = engine.Evaluate("""
            var done = chan[int32](1)
            func poke() {
                done <- 42
            }
            go poke()
            <-done
            """);
        Assert.False(cell.HasError, string.Join("; ", cell.Diagnostics));
        Assert.Equal(42, cell.Value);
    }
}
