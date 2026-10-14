// <copyright file="Issue836IteratorTryFinallyBinderTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #836 — the binder's acceptance contract for `yield`
/// statements nested inside `try` blocks. Pure `try`/
/// `finally` around `yield` binds cleanly; the presence of
/// any `catch` clause on the same `try` raises GS0367 (the
/// state machine cannot resume into a protected region that doubles as
/// a CLR exception-handler frame).
open class Issue836IteratorTryFinallyBinderTests {
    @Fact
    func YieldInsideTryFinally_Accepted() {
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
    } finally {
        var done = true
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func YieldInsideTryWithCatch_RejectedWithGS0367() {
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        yield 1
    } catch (e Exception) {
        var caught = true
    }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0367")
    }

    @Fact
    func YieldInsideTryCatchFinally_RejectedWithGS0367() {
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        yield 1
    } catch (e Exception) {
        var caught = true
    } finally {
        var done = true
    }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0367")
    }

    @Fact
    func NestedTryFinally_BothLevelsContainYields_Accepted() {
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            var inner = true
        }
    } finally {
        var outer = true
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NestedTryFinally_InnerHasCatchWithYield_InnerRejected() {
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
        } catch (e Exception) {
            var caught = true
        }
    } finally {
        var done = true
    }
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0367")
    }

    @Fact
    func TryWithCatch_NoYield_StillBinds() {
        // Non-iterator try/catch is unaffected.
        let (diagnostics, _) = Compile(`import System
func gen() int32 {
    try {
        return 1
    } catch (e Exception) {
        return 0
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TryWithCatch_YieldInNestedLambda_NotRejected() {
        // A `yield` lexically inside a nested function body should not
        // count as belonging to the outer try/catch (different lexical
        // scope; the inner lambda would have its own iterator semantics
        // if it returned a sequence).
        let (diagnostics, _) = Compile(`import System
import System.Collections.Generic
func gen() IEnumerable[int32] {
    try {
        let inner = func() IEnumerable[int32] {
            yield 1
        }
        for v in inner() {
            yield v
        }
        yield 99
    } finally {
        var done = true
    }
}`)
        // The outer try has only a finally, not a catch — should be
        // accepted regardless of where the inner lambda's yield lives.
        Assert.Empty(diagnostics)
    }

    shared {
        // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
        // state; nothing needs to run.
        private func Compile(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let syntaxTree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(syntaxTree)
            let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
            return (diagnostics, compilation)
        }
    }
}
