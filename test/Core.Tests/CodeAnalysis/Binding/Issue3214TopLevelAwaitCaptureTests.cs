// <copyright file="Issue3214TopLevelAwaitCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3214 — statement-level awaits (<c>await for</c>, <c>await using</c>)
/// in top-level statements must make the synthesized entry point async just
/// like an expression-level <c>await</c> (ADR-0066 D3), so the emitted
/// submission runs them through the async state-machine lowering instead of
/// failing with GS9998. Also pins the ADR-0156 Phase 2 <c>&lt;Result&gt;$</c>
/// capture of an awaited trailing value.
/// </summary>
public class Issue3214TopLevelAwaitCaptureTests
{
    [Fact]
    public void TrailingAwaitExpression_ValueCaptured()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading.Tasks

            await Task.FromResult(42)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void AwaitedDeclarationThenTrailingVariable_ValueCaptured()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading.Tasks

            let half = await Task.FromResult(21)
            half * 2
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TopLevelAwaitUsing_RunsAndDisposesAsynchronously()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Threading.Tasks

            class Resource : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("disposed")
                    return ValueTask.CompletedTask
                }
            }

            {
                await using let r = Resource{}
                Console.WriteLine("body")
            }
            Console.WriteLine("after")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"body{Environment.NewLine}disposed{Environment.NewLine}after{Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine));
    }

    [Fact]
    public void TopLevelAwaitFor_TrailingIf_CapturesBranchValue()
    {
        // #3214 x #3227: an async entry point still routes the trailing
        // branching capture through the state machine.
        var result = EmittedOracle.Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            var total = 0
            await for v in AsyncStreamFixture.Counts() {
                total = total + v
            }
            if total == 6 { "drained" } else { "partial" }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("drained", result.Value);
    }
}
