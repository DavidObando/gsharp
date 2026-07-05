// <copyright file="SessionEngineCancellationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class SessionEngineCancellationTests
{
    [Fact]
    public async Task EvaluateAsync_CancelledBeforeCommit_DoesNotAppendCellOrMutateState()
    {
        var engine = new SessionEngine();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => engine.EvaluateAsync("let x = 1", cts.Token));

        Assert.Empty(engine.Cells);

        // Session state must be untouched: a later, uncancelled evaluation referencing "x"
        // should fail to resolve it, proving the cancelled submission never committed.
        var next = engine.Evaluate("x");
        Assert.True(next.HasError);
    }

    [Fact]
    public async Task EvaluateAsync_NotCancelled_CommitsCellNormally()
    {
        var engine = new SessionEngine();
        var cell = await engine.EvaluateAsync("1 + 1", CancellationToken.None);

        Assert.Single(engine.Cells);
        Assert.False(cell.HasError);
    }
}
