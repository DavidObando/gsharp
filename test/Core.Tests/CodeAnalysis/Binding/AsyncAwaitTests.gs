// <copyright file="AsyncAwaitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Phase 5.1 + 5.2 — `async func` declarations and `await` expressions.
open class AsyncAwaitTests {
    @Fact
    func AsyncFunction_DeclaresAndBinds() {
        let source = `
async func answer() int32 {
    return 42
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Await_AsyncUserFunction_UnwrapsResultType() {
        let source = `
async func answer() int32 {
    return 42
}

async func main() int32 {
    let v = await answer()
    return v
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    /// ADR-0174 D4, the `await g()` row (issue #3954): awaiting makes the
    /// AWAITING function suspending, so a plain `func` may await — the
    /// inference pass colours it, exactly as a channel operation would. Before
    /// this row was implemented the same source was GS0132.
    @Fact
    func Await_InAPlainFunc_ColoursTheCaller() {
        let source = `
async func answer() int32 {
    return 42
}

func main() int32 {
    let v = await answer()
    return v
}

main()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(42, result.Value)
    }

    /// ADR-0174 D4 "where inference stops": a boundary's signature is fixed, so
    /// an `await` there has nowhere to suspend and GS0574 asks the author
    /// to choose the coloring. This is the half of the rule that keeps the
    /// previous diagnostic's job.
    @Fact
    func Await_AtASuspensionBoundary_Diagnoses() {
        let source = `
async func answer() int32 {
    return 42
}

open class Reader {
    open func read() int32 {
        return await answer()
    }
}
`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0574")
        Assert.Contains("'read'", diagnostic.Message)
    }

    @Fact
    func Await_NonTask_Diagnoses() {
        let source = `
async func main() int32 {
    let v = await 42
    return v
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("cannot be awaited"))
    }

    @Fact
    func AsyncCall_AtTopLevel_ProducesTask() {
        // The call expression in an expression-statement is allowed even though
        // we cannot await it here. We just verify it binds cleanly.
        let source = `
async func tick() int32 {
    return 1
}

tick()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    // Issue #502 (original parse repro from the issue body): an `async func`
    // class instance member must parse and bind without `GS0005`. The
    // member-level parse fix shipped previously; this guard prevents a
    // future regression that would block #502's worked example.
    @Fact
    func AsyncClassMember_ParsesAndBinds() {
        let source = `
class SmokeTests {
    init() {}
    async func DoIt() {
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    // Issue #502 sub-bug 502-a: an `async func ... T` declared as a class
    // instance member must be awaitable from a sibling instance member.
    // Before the fix, the rewriter dropped the call-site Task[T] wrap on the
    // user-instance call when its receiver was rewritten (e.g. by the async
    // state-machine rewriter hoisting `this`), producing GS0133-style
    // mismatch downstream. We assert clean binding here as the binder-level
    // regression guard.
    @Fact
    func AsyncClassMember_AwaitsSiblingAsyncMember_NoDiagnostics() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
