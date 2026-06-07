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

    [Fact]
    public void Await_OutsideAsync_Diagnoses()
    {
        var source = @"
async func answer() int32 {
    return 42
}

func main() int32 {
    let v = await answer()
    return v
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'await'"));
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
type SmokeTests class {
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
type Probe class {
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

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
