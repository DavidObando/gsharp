// <copyright file="Issue5197NativeProtocolMemoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import Xunit

/// Issue #5197 — the native protocol safety pass asked an uncached question
/// about the type of every bound expression. The pass now answers each distinct
/// type once per run. The test guards the shape (walks do not scale with the
/// expression count), not a wall-clock time.
class Issue5197NativeProtocolMemoTests {
    @Fact
    func SafetyPass_WalksEachTypeOnce_NotEachExpression() {
        let small = Bind(Body(2))
        let large = Bind(Body(200))
        Assert.True(large.Hits > small.Hits, "more expressions must mean more memo hits")
        // The distinct types are the same, so the number of real walks is too.
        Assert.Equal(small.Walks, large.Walks)
    }

    @Fact
    func Memo_IsReleasedAfterEachRun() {
        // A second program bound on the same thread starts with an empty memo,
        // so it walks its own types again rather than reusing the first run's.
        let first = Bind(Body(5))
        let second = Bind(Body(5))
        Assert.True(first.Walks > 0)
        Assert.Equal(first.Walks, second.Walks)
    }

    private data struct Counts(Walks int64, Hits int64)

    shared {
        private func Body(statements int32) string {
            let sb = System.Text.StringBuilder()
            sb.AppendLine("func Main() int32 {")
            sb.AppendLine("    var total int32 = 0")
            for var i = 0; i < statements; i++ {
                sb.AppendLine("    total = total + ${i}")
            }
            sb.AppendLine("    return total")
            sb.AppendLine("}")
            return sb.ToString()
        }

        private func Bind(source string) Counts {
            using let measurements = CompilationMeasurements.Start("issue5197")
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            let program = Binder.BindProgram(globalScope)
            Assert.Empty(program.Diagnostics)
            return Counts(
                measurements.GetCounter("nativeprotocol.memo-walks"),
                measurements.GetCounter("nativeprotocol.memo-hits")
            )
        }
    }
}
