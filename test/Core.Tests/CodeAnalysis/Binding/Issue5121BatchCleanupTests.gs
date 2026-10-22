// <copyright file="Issue5121BatchCleanupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue5121BatchCleanupTests {
    private func Source() string -> `package P
func Zeta() int32 {
    return 1
}
func Alpha() int32 {
    return 2
}
func Mid() int32 {
    return 3
}`

    private func BindProgram(cache BoundBodyCache?) BoundProgram {
        let tree = SyntaxTree.Parse(SourceText.From(Source(), "A.gs"))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        return Binder.BindProgram(scope_, references: nil, cache)
    }

    @Fact
    func BodyBinding_WithoutBodyCache_SkipsTheCacheabilityWalk() {
        using let measurements = CompilationMeasurements.Start("test")
        let program = BindProgram(nil)
        Assert.True(program.Functions.Count >= 3)
        Assert.Equal(0L, measurements.GetCounter("binding.body-cacheability-walks"))
    }

    @Fact
    func BodyBinding_WithBodyCache_StillWalksEachBodyOnce() {
        using let measurements = CompilationMeasurements.Start("test")
        let cache = BoundBodyCache()
        let program = BindProgram(cache)
        let bodies = program.Functions.Count
        Assert.True(bodies >= 3)
        Assert.Equal(cast[int64](bodies), measurements.GetCounter("binding.body-cacheability-walks"))
    }

    @Fact
    func Functions_AreSortedOncePerProgram_InSourceOrder() {
        using let measurements = CompilationMeasurements.Start("test")
        let program = BindProgram(nil)
        let first = BoundProgramOrder.Functions(program)
        let second = BoundProgramOrder.Functions(program)
        let third = program.OrderedFunctions
        Assert.Equal(1L, measurements.GetCounter("emit.function-sorts"))
        Assert.Equal(first, second)
        Assert.Equal(first, third)
        // Source order, not name order and not map order.
        let names = first
            .Select((pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> pair.Key.Name)
            .Where((name string) -> name == "Zeta" || name == "Alpha" || name == "Mid")
            .ToArray()
        Assert.Equal([]string{"Zeta", "Alpha", "Mid"}, names)
    }

    @Fact
    func TextLocation_GetLineRange_MatchesTheFourProperties() {
        let text = SourceText.From("abc\r\n  def\r\nghi\r\n")
        let starts = []int32{0, 1, 7, 2, 5, text.Length}
        let ends = []int32{2, 3, 12, 14, 5, text.Length}
        for var i = 0; i < starts.Length; i++ {
            let start = starts[i]
            let end = ends[i]
            let location = TextLocation(text, TextSpan.FromBounds(start, end))
            let lines = location.GetLineRange()
            Assert.Equal(location.StartLine, lines.StartLine)
            Assert.Equal(location.StartCharacter, lines.StartCharacter)
            Assert.Equal(location.EndLine, lines.EndLine)
            Assert.Equal(location.EndCharacter, lines.EndCharacter)
        }
        let spanning = TextLocation(text, TextSpan.FromBounds(7, 12)).GetLineRange()
        Assert.Equal(1, spanning.StartLine)
        Assert.Equal(2, spanning.StartCharacter)
        Assert.Equal(2, spanning.EndLine)
        Assert.Equal(0, spanning.EndCharacter)
    }
}
