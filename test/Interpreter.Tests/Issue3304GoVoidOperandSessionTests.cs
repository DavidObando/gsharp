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
        // ADR-0082: the Go surface is gated per compilation unit, so each
        // cell that uses `go`/`chan`/`<-` carries the import.
        var declare = engine.Evaluate("""
            import Gsharp.Extensions.Go
            var done = make(chan int32, 1)
            func poke() {
                done <- 42
            }
            """);
        Assert.False(declare.HasError);

        var launch = engine.Evaluate("""
            import Gsharp.Extensions.Go
            go poke()
            <-done
            """);
        Assert.False(launch.HasError);
        Assert.Equal(42, launch.Value);
    }
}
