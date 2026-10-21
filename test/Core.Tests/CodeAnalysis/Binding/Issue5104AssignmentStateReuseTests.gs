// <copyright file="Issue5104AssignmentStateReuseTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue5104AssignmentStateReuseTests {
    @Fact
    func BranchAndJoinStates_RemainIndependent() {
        const source = `func Run(condition bool) {
    var c chan[int32]
    if condition {
        c = chan[int32](1)
    } else {
        c <- 1
    }
    c <- 2
}`
        let diagnostics = Bind(source)
        Assert.Equal(
            []int32{source.IndexOf("c <- 1"), source.IndexOf("c <- 2")},
            diagnostics.Select((d Diagnostic) -> d.Location.Span.Start).ToArray()
        )
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Equal("GS0522", d.Id))
    }

    @Fact
    func LoopBackEdge_PreservesEntryButNotBodyOnlyAssignment() {
        const source = `func Run(condition bool) {
    var seeded chan[int32]
    seeded = chan[int32](1)
    var bodyOnly chan[int32]
    for condition {
        seeded <- 1
        bodyOnly = chan[int32](1)
    }
    seeded <- 2
    bodyOnly <- 3
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0522", diagnostic.Id)
        Assert.Equal(source.IndexOf("bodyOnly <- 3"), diagnostic.Location.Span.Start)
    }

    @Fact
    func NestedRegions_KeepTryEntrySeparateFromCatchAndFinally() {
        const source = `import System

func Run() {
    var c chan[int32]
    var finalized chan[int32]
    try {
        try {
            c = chan[int32](1)
        } finally {
            finalized = chan[int32](1)
        }
    } catch (e Exception) {
        c <- 1
    } finally {
        finalized = chan[int32](1)
    }
    c <- 2
    finalized <- 3
}`
        let diagnostics = Bind(source)
        Assert.Equal(
            []int32{source.IndexOf("c <- 1"), source.IndexOf("c <- 2")},
            diagnostics.Select((d Diagnostic) -> d.Location.Span.Start).ToArray()
        )
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Equal("GS0522", d.Id))
    }

    @Theory
    @InlineData("if condition && Assign(out value) { return true }", false)
    @InlineData("if condition || Assign(out value) { return true }", true)
    @InlineData("if !(condition || Assign(out value)) { return true }", false)
    @InlineData("if !(condition && Assign(out value)) { return true }", true)
    func ConditionalEdges_KeepTheirOwnOutAssignments(branch string, rejected bool) {
        let source = `func Assign(out value int32) bool {
    value = 1
    return true
}

func Run(condition bool, out value int32) bool {
    ` + branch + `
    value = 2
    return false
}`
        let diagnostics = Bind(source)
        if rejected {
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal("GS0238", diagnostic.Id)
            Assert.Equal(source.IndexOf("{ return true }") + 2, diagnostic.Location.Span.Start)
        } else {
            Assert.Empty(diagnostics)
        }
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            return Binder.BindProgram(globalScope).Diagnostics
        }
    }
}
