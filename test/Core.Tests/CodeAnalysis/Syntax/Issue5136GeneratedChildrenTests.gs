// <copyright file="Issue5136GeneratedChildrenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// Issue #5136 (M7): every concrete syntax node class has generated `ChildCount` and
/// `GetChild(index)` members (`SyntaxNode.Children.g.gs`, written by
/// `build/generate-syntax-children.py`). `GetChildren` reads them. The reflection path stays as the
/// oracle. These tests compare the two on every node of the corpus and pin the span the node
/// computes from its children. Issue5185ChildSourceOrderTests checks the order of the children.
open class Issue5136GeneratedChildrenTests {
    /// A concrete node class without generated members would fall back to reflection and allocate.
    /// The fallback is only for a class that the generator did not see.
    @Fact
    func EveryConcreteNodeClass_OverridesTheGeneratedChildAccessors() {
        let types = Issue1675SyntaxNodeChildEnumerationTests.GetConcreteNodeTypes()
        Assert.True(types.Count > 100, "only ${types.Count} concrete syntax node types")
        let flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
        let missing = List[string]()
        for type in types {
            // A class with a computed child sequence overrides BuildChildren instead.
            let direct = type.GetProperty("ChildCount", flags) != nil && type.GetMethod("GetChild", flags) != nil
            if !direct && type.GetMethod("BuildChildren", flags) == nil && type.GetMethod(
                "BuildUnsortedChildren",
                flags
            ) == nil {
                missing.Add(type.Name)
            }
        }
        Assert.True(
            missing.Count == 0,
            "No generated child accessors for: " + string.Join(", ", missing) +
                ". Add 'partial' to the class and run python3 build/generate-syntax-children.py."
        )
    }

    /// For every node of the corpus, `ChildCount` equals the reflection count and `GetChild(i)`
    /// returns the same instance as the reflection path at the same index.
    @Fact
    func GeneratedChildren_MatchTheReflectionOracle_OnCorpus() {
        var nodes = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            nodes += AssertMatchesOracle(tree.Root)
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
    }

    /// `GetChild` rejects an index outside the child range for generated and token nodes.
    @Fact
    func GetChild_RejectsAnOutOfRangeIndex() {
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 { return 1 + 2 }\n")
        let binary = Descendants(tree.Root).OfType[BinaryExpressionSyntax]().First()
        Assert.Equal(3, binary.ChildCount)
        Assert.Throws[ArgumentOutOfRangeException](() -> binary.GetChild(3))
        Assert.Throws[ArgumentOutOfRangeException](() -> binary.GetChild(-1))
        let token = Descendants(tree.Root).OfType[SyntaxToken]().First()
        Assert.Equal(0, token.ChildCount)
        Assert.Throws[ArgumentOutOfRangeException](() -> token.GetChild(0))
    }

    /// Optional children that are absent do not count, and the index skips them. A `return`
    /// without a value has only the keyword; a `return` with a value has two children.
    @Fact
    func OptionalChildren_AreSkippedByTheIndex() {
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 {\n return\n}\nfunc G() int32 {\n return 1\n}\n")
        let returns = Descendants(tree.Root).OfType[ReturnStatementSyntax]().ToList()
        Assert.Equal(2, returns.Count)
        Assert.Equal(1, returns[0].ChildCount)
        Assert.Equal(SyntaxKind.ReturnKeyword, returns[0].GetChild(0).Kind)
        Assert.Equal(2, returns[1].ChildCount)
        Assert.Equal(SyntaxKind.LiteralExpression, returns[1].GetChild(1).Kind)
    }

    /// The span of every node still equals the bounds of its children. It is checked against a
    /// minimum and maximum over the reflection children, which does not depend on child order.
    @Fact
    func Span_EqualsTheBoundsOfTheReflectionChildren_OnCorpus() {
        var nodes = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                // A token has no children and reports its own span.
                if node is SyntaxToken {
                    continue
                }
                var start = int32.MaxValue
                var end = int32.MinValue
                var any = false
                for child in node.GetChildrenByReflection() {
                    start = Math.Min(start, child.Span.Start)
                    end = Math.Max(end, child.Span.End)
                    any = true
                }
                let expected = if any {
                    TextSpan.FromBounds(start, end)
                } else {
                    TextSpan(0, 0)
                }
                Assert.True(
                    expected.Equals(node.Span),
                    "${node.GetType().Name}: expected ${expected}, got ${node.Span}"
                )
                nodes++
            }
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
    }

    /// A subclass of a public open node class can add a child property. The generated accessors of
    /// the base class only know its own properties, so the subclass must take the reflection path
    /// and keep the added child in `GetChildren`, the span and the walker.
    @Fact
    func UngeneratedSubclass_KeepsItsAddedChild() {
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 { return 1 + 2 }\n")
        let binary = Descendants(tree.Root).OfType[BinaryExpressionSyntax]().First()
        let extra = tree.Root.GetLastToken()
        let sub = BinaryWithExtra(tree, binary.Left, binary.OperatorToken, binary.Right, extra)
        using let measurements = CompilationMeasurements.Start("issue5136")
        Assert.Equal(4, sub.ChildCount)
        let children = sub.GetChildren().ToList()
        Assert.Equal(4, children.Count)
        // Reflection lists the properties of the runtime type before those of its base class.
        Assert.Same(extra, children[0])
        Assert.Same(extra, sub.GetChild(0))
        Assert.Same(binary.Left, sub.GetChild(1))
        Assert.Equal(extra.Span.End, sub.Span.End)
        let walker = CollectingWalker()
        walker.Visit(sub)
        Assert.Contains(extra, walker.Visited)
        Assert.True(measurements.GetCounter("syntax.child-reflection-fallbacks") > 0)
        // The base class itself stays on the generated path.
        Assert.Equal(3, binary.ChildCount)
    }

    /// A node with a computed child sequence builds it once. An interpolated string with 2,000
    /// holes must not copy the holes again for each lookup.
    @Fact
    func ComputedChildSequence_IsBuiltOncePerNode() {
        let holes = string.Join("", Enumerable.Repeat("$" + "{x}", 2000))
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32) string { return \"" + holes + "\" }\n")
        let interpolated = Descendants(tree.Root).OfType[InterpolatedStringExpressionSyntax]().First()
        using let measurements = CompilationMeasurements.Start("issue5136")
        let count = interpolated.ChildCount
        Assert.Equal(2001, count)
        for var i = 0; i < count; i++ {
            interpolated.GetChild(i)
        }
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < count; i++ {
            interpolated.GetChild(i)
        }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        Assert.Equal(1L, measurements.GetCounter("syntax.child-projections"))
        Assert.True(allocated < 16_384L, "lookups allocated $allocated bytes")
    }

    /// A call with 2,000 arguments reads its list in place and builds no projection.
    @Fact
    func LargeArgumentList_BuildsNoProjection() {
        let arguments = string.Join(", ", Enumerable.Repeat("1", 2000))
        let tree = SyntaxTree.Parse("package p\nfunc G(a int32) { }\nfunc F() { G(" + arguments + ") }\n")
        let call = Descendants(tree.Root).OfType[CallExpressionSyntax]().First()
        using let measurements = CompilationMeasurements.Start("issue5136")
        let count = call.ChildCount
        for var i = 0; i < count; i++ {
            call.GetChild(i)
        }
        Assert.True(count > 3999, "only $count children")
        Assert.Equal(0L, measurements.GetCounter("syntax.child-projections"))
    }

    private class BinaryWithExtra : BinaryExpressionSyntax {
        init(
            syntaxTree SyntaxTree,
            left ExpressionSyntax,
            operatorToken SyntaxToken,
            right ExpressionSyntax,
            extra SyntaxToken
        ) : base(syntaxTree, left, operatorToken, right) {
            Extra = extra
        }

        prop Extra SyntaxToken {
            get;
        }
    }

    private class CollectingWalker : GSharpSyntaxWalker {
        private let visited List[SyntaxNode] = List[SyntaxNode]()

        prop Visited List[SyntaxNode] -> visited

        override func Visit(node SyntaxNode?) {
            if node != nil {
                Visited.Add(node)
            }
            base.Visit(node)
        }
    }

    shared {
        private func AssertMatchesOracle(node SyntaxNode) int32 {
            let expected = node.GetChildrenByReflection().ToList()
            Assert.True(
                expected.Count == node.ChildCount,
                "${node.GetType().Name}: expected ${expected.Count} children, ChildCount is ${node.ChildCount}"
            )
            var total = 1
            for var i = 0; i < expected.Count; i++ {
                Assert.Same(expected[i], node.GetChild(i))
            }
            for child in expected {
                total += AssertMatchesOracle(child)
            }
            return total
        }

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
}
