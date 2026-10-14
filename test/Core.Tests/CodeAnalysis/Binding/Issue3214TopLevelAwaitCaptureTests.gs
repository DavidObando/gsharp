// <copyright file="Issue3214TopLevelAwaitCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import System
import Xunit

/// Issue #3214 — statement-level awaits (`await for`, `await using`)
/// in top-level statements must make the synthesized entry point async just
/// like an expression-level `await` (ADR-0066 D3), so the emitted
/// submission runs them through the async state-machine lowering instead of
/// failing with GS9998. Also pins the ADR-0156 Phase 2 `<Result>$`
/// capture of an awaited trailing value.
open class Issue3214TopLevelAwaitCaptureTests {
    @Fact
    func TrailingAwaitExpression_ValueCaptured() {
        let result = EmittedOracle.Evaluate(`import System.Threading.Tasks

await Task.FromResult(42)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func AwaitedDeclarationThenTrailingVariable_ValueCaptured() {
        let result = EmittedOracle.Evaluate(`import System.Threading.Tasks

let half = await Task.FromResult(21)
half * 2`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TopLevelAwaitUsing_RunsAndDisposesAsynchronously() {
        let result = EmittedOracle.Evaluate(`import System
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
Console.WriteLine("after")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            "body${Environment.NewLine}disposed${Environment.NewLine}after${Environment.NewLine}",
            result.Output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func TopLevelAwaitFor_TrailingIf_CapturesBranchValue() {
        // #3214 x #3227: an async entry point still routes the trailing
        // branching capture through the state machine.
        let result = EmittedOracle.Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
if total == 6 { "drained" } else { "partial" }`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("drained", result.Value)
    }
}
