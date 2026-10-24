// <copyright file="Issue5201NativeProtocolWalkTests.cs" company="GSharp">
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

/// Issue #5201 — every top-level native protocol walk started with an empty
/// visited set, so a class whose fields reach most of the program's types made
/// each walk cost the whole reachable graph, and the pass cost grew with the
/// square of the type count. A walk that finds nothing now records every type
/// it entered as protocol-free, and a later walk stops at them. The test guards
/// the shape (types entered grow in step with the type count) with counts, never
/// a wall-clock time.
class Issue5201NativeProtocolWalkTests {
    @Fact
    func Walks_DoNotRevisitProtocolFreeTypes() {
        let small = Bind(Chain(30))
        let large = Bind(Chain(60))
        Assert.True(small.Entered > 0, "the chain's types must be walked")
        // Doubling the chain doubles the work; the old per-walk restart made it
        // four times as much (the sum of 1..N entered types).
        Assert.True(
            large.Entered <= small.Entered * 5 / 2,
            "types entered must grow linearly: ${small.Entered} for 30, ${large.Entered} for 60"
        )
        // A restart per walk enters at least N * (N + 1) / 2 types.
        Assert.True(large.Entered < 60 * 61 / 2, "entered ${large.Entered} types for a 60-class chain")
        Assert.True(large.Pruned > 0, "later walks must stop at types an earlier walk settled")
    }

    private data struct Counts(Entered int64, Pruned int64)

    shared {
        private func Chain(count int32) string {
            let sb = System.Text.StringBuilder()
            for var i = 0; i < count; i++ {
                sb.AppendLine("class C${i} {")
                sb.AppendLine("    var Value int32")
                if i + 1 < count {
                    sb.AppendLine("    var Next C${i + 1}?")
                }
                sb.AppendLine("}")
            }
            sb.AppendLine("func Main() int32 {")
            sb.AppendLine("    return 0")
            sb.AppendLine("}")
            return sb.ToString()
        }

        private func Bind(source string) Counts {
            using let measurements = CompilationMeasurements.Start("issue5201")
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(Binder.BindProgram(globalScope).Diagnostics)
            return Counts(
                measurements.GetCounter("nativeprotocol.walk-entered"),
                measurements.GetCounter("nativeprotocol.memo-pruned")
            )
        }
    }
}
