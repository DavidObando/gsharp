// <copyright file="AsyncAwaitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.1 + 5.2 — <c>async func</c> declarations and <c>await</c> expressions.
/// </summary>
public class AsyncAwaitTests
{
    [Fact]
    public void AsyncFunction_DeclaresAndBinds()
    {
        var source = @"
async func answer() int32 {
    return 42
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Await_AsyncUserFunction_UnwrapsResultType()
    {
        var source = @"
async func answer() int32 {
    return 42
}

async func main() int32 {
    let v = await answer()
    return v
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    /// <summary>
    /// ADR-0174 D4, the <c>await g()</c> row (issue #3954): awaiting makes the
    /// AWAITING function suspending, so a plain <c>func</c> may await — the
    /// inference pass colours it, exactly as a channel operation would. Before
    /// this row was implemented the same source was GS0132.
    /// </summary>
    [Fact]
    public void Await_InAPlainFunc_ColoursTheCaller()
    {
        var source = @"
async func answer() int32 {
    return 42
}

func main() int32 {
    let v = await answer()
    return v
}

main()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    /// <summary>
    /// ADR-0174 D4 "where inference stops": a boundary's signature is fixed, so
    /// an <c>await</c> there has nowhere to suspend and GS0574 asks the author
    /// to choose the coloring. This is the half of the rule that keeps the
    /// previous diagnostic's job.
    /// </summary>
    [Fact]
    public void Await_AtASuspensionBoundary_Diagnoses()
    {
        var source = @"
async func answer() int32 {
    return 42
}

open class Reader {
    open func read() int32 {
        return await answer()
    }
}
";
        var result = Evaluate(source);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0574");
        Assert.Contains("'read'", diagnostic.Message);
    }

    [Fact]
    public void Await_NonTask_Diagnoses()
    {
        var source = @"
async func main() int32 {
    let v = await 42
    return v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("cannot be awaited"));
    }

    [Fact]
    public void AsyncCall_AtTopLevel_ProducesTask()
    {
        // The call expression in an expression-statement is allowed even though
        // we cannot await it here. We just verify it binds cleanly.
        var source = @"
async func tick() int32 {
    return 1
}

tick()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    // Issue #502 (original parse repro from the issue body): an `async func`
    // class instance member must parse and bind without `GS0005`. The
    // member-level parse fix shipped previously; this guard prevents a
    // future regression that would block #502's worked example.
    [Fact]
    public void AsyncClassMember_ParsesAndBinds()
    {
        var source = @"
class SmokeTests {
    init() {}
    async func DoIt() {
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    // Issue #502 sub-bug 502-a: an `async func ... T` declared as a class
    // instance member must be awaitable from a sibling instance member.
    // Before the fix, the rewriter dropped the call-site Task[T] wrap on the
    // user-instance call when its receiver was rewritten (e.g. by the async
    // state-machine rewriter hoisting `this`), producing GS0133-style
    // mismatch downstream. We assert clean binding here as the binder-level
    // regression guard.
    [Fact]
    public void AsyncClassMember_AwaitsSiblingAsyncMember_NoDiagnostics()
    {
        var source = @"
class Probe {
    init() {}

    async func ReturnInt() int32 {
        return 42
    }

    async func CallIt() int32 {
        let r = await ReturnInt()
        return r
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
