// <copyright file="Adr0174GoBlockEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D14 through real emitted execution: <c>go { … }</c> spawns the block
/// as a goroutine that captures the enclosing locals — per iteration for a
/// <c>for … in</c> variable — and joins with the enclosing <c>scope</c>.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that hoists the loop variable
/// out of the per-iteration binding breaks
/// <see cref="GoBlock_InForIn_RecordsEveryDistinctElement"/>, which sees a
/// repeated element instead of the full set.
/// </remarks>
public class Adr0174GoBlockEmitTests
{
    [Fact]
    public void GoBlock_InForIn_RecordsEveryDistinctElement()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoBlockLoop
            let results = chan[int32](5)
            scope {
                for v in 1 ... 6 {
                    go {
                        results <- v
                    }
                }
            }
            results.Close()
            var sum = 0
            var mask = 0
            for r in results {
                sum = sum + r
                mask = mask | (1 << r)
            }
            sum * 100 + mask
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(15 * 100 + 0b111110, result.Value);
    }

    [Fact]
    public void GoBlock_CapturesAndMutatesAThroughChannel()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoBlockCapture
            let ch = chan[int32](1)
            let x = 41
            scope {
                go {
                    ch <- x + 1
                }
            }
            <-ch
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GoBlock_FailureInsideScope_IsAScopeException()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174GoBlockFail
            import System
            import Gsharp.Concurrency
            var caught = ""
            try {
                scope {
                    go {
                        throw InvalidOperationException("block")
                    }
                }
            } catch (e ScopeException) {
                caught = e.FirstFailure.Message
            }
            caught
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("block", result.Value);
    }
}
