// <copyright file="Issue5279InPlaceChildOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #5279: a source-ordered node whose properties are already in source order returns its
/// children in place. It builds the sorted array only when a start check finds an inversion. The
/// tests count projections and checks; they never measure time.
open class Issue5279InPlaceChildOrderTests {
    /// A prefix operator is listed first in the properties and in the source: no array is built.
    @Fact
    func OrderedNode_ReadsItsChildrenInPlace() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32) int32 { return -x }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        using let measurements = CompilationMeasurements.Start("issue5279")
        Assert.Equal(2, unary.ChildCount)
        Assert.Same(unary.OperatorToken, unary.GetChild(0))
        Assert.Same(unary.Operand, unary.GetChild(1))
        Assert.Equal(2, unary.GetChildren().Count())
        Assert.Equal(0L, measurements.GetCounter("syntax.child-projections"))
        Assert.Equal(0L, measurements.GetCounter("syntax.child-order-inversions"))
        Assert.Equal(unary.ChildCount, unary.PropertyChildCount)
        Assert.Same(unary.GetChild(0), unary.PropertyChild(0))
    }

    /// A postfix operator is listed first in the properties and last in the source: the node
    /// builds the sorted array once and the check runs once.
    @Fact
    func InvertedNode_BuildsTheSortedArrayOnce() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32?) int32 { return x!! }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        using let measurements = CompilationMeasurements.Start("issue5279")
        Assert.Equal(2, unary.ChildCount)
        Assert.Same(unary.Operand, unary.GetChild(0))
        Assert.Same(unary.OperatorToken, unary.GetChild(1))
        Assert.Same(unary.Operand, unary.GetChildren().First())
        Assert.Equal(1L, measurements.GetCounter("syntax.child-projections"))
        Assert.Equal(1L, measurements.GetCounter("syntax.child-order-inversions"))
        // The property order stays available to a span.
        Assert.Same(unary.OperatorToken, unary.PropertyChild(0))
        Assert.Same(unary.Operand, unary.PropertyChild(1))
    }

    /// The plan constant of every generated class agrees with the reflection that decides the
    /// same questions for a class the generator did not see, on every node of the corpus.
    @Fact
    func GeneratedSpanPlan_AgreesWithReflection_OnCorpus() {
        var nodes = 0
        var inPlace = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                nodes++
                let plan = node.SpanPlan
                let reflected = SyntaxNode.ReflectedSpanPlan(node.GetType())
                if (plan & SyntaxNode.PlanInPlace) != 0 {
                    inPlace++
                    Assert.True((plan & SyntaxNode.PlanSourceOrdered) != 0, node.GetType().Name)
                }
                Assert.True(
                    (plan & ~SyntaxNode.PlanInPlace) == reflected,
                    "${node.GetType().Name}: plan $plan, reflected $reflected"
                )
            }
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
        Assert.True(inPlace > 1_000, "only $inPlace nodes read their children in place")
    }

    /// The projections of a fixed corpus stay below a bound. Before #5279 every node of a marked
    /// class built an array (about 127,000 on Core against 72,000 before #5275). Now only a node
    /// with an inversion or a computed child property does. The bound is a count, not a time.
    @Fact
    func ChildWalk_OfTheCorpus_BuildsFewProjections() {
        let trees = Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus().ToList()
        using let measurements = CompilationMeasurements.Start("issue5279")
        var nodes = 0
        for tree in trees {
            for node in Descendants(tree.Root) {
                nodes++
                for child in node.GetChildren() {
                    Assert.NotNull(child)
                }
            }
        }
        let projections = measurements.GetCounter("syntax.child-projections")
        let inversions = measurements.GetCounter("syntax.child-order-inversions")
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
        Assert.True(inversions > 0L, "the corpus has no inverted node")
        // Every inverted node builds one array, and the nodes of a class with a computed property
        // build one anyway. Both are a small share of the nodes.
        Assert.True(projections < nodes / 4, "projections $projections for $nodes nodes")
        Assert.True(projections <= BoundProjections, "projections $projections, bound $BoundProjections")
    }

    /// Measured 2,308 on this corpus when the check was added.
    private let BoundProjections int64 = 2_600

    private func Descendants(root SyntaxNode) sequence[SyntaxNode] {
        let stack = Stack[SyntaxNode]()
        stack.Push(root)
        while stack.Count > 0 {
            let node = stack.Pop()
            yield node
            let count = node.ChildCount
            for var i = count - 1; i >= 0; i-- {
                stack.Push(node.GetChild(i))
            }
        }
    }
}
