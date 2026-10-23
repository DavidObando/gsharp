// <copyright file="Issue5136GeneratedChildrenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #5136 (M7): every concrete syntax node class has generated `ChildCount` and
/// `GetChild(index)` members (`SyntaxNode.Children.g.gs`, written by
/// `build/generate-syntax-children.py`). `GetChildren` reads them. The reflection path stays as the
/// oracle. These tests compare the two on every node of the corpus, pin the span the node computes
/// from its children, and record where the child order is not the source order.
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
            if type.GetProperty("ChildCount", flags) == nil || type.GetMethod("GetChild", flags) == nil {
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

    /// The children are not always in source order, and a fixed property order cannot make them
    /// so. A unary expression lists its operator first, but a postfix `!!` follows its operand. A
    /// type clause lists the same properties for `string?`, `[]T` and `(a) -> b`. A struct keeps
    /// fields, methods and nested types in separate lists. Because of this, a node takes its span
    /// from the minimum start and the maximum end of its children, not from the first and last
    /// child. This test lists every (node class, previous child kind, next child kind) whose start
    /// goes backward in the corpus. A new entry means a class has a new out-of-order shape: review
    /// it, then regenerate with GSHARP_UPDATE_GOLDENS=1.
    @Fact
    func ChildrenOutOfSourceOrder_MatchTheRecordedInversions() {
        let found = SortedSet[string](StringComparer.Ordinal)
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                var previous SyntaxNode? = nil
                let count = node.ChildCount
                for var i = 0; i < count; i++ {
                    let child = node.GetChild(i)
                    if previous != nil && child.Span.Start < previous.Span.Start {
                        found.Add("${node.GetType().Name}: ${previous.Kind} -> ${child.Kind}")
                    }
                    previous = child
                }
            }
        }
        Assert.True(found.Count > 0, "the corpus no longer has any out-of-order child")
        GoldenFile.AssertMatches(
            Path.Combine(
                LocateRepoRoot(),
                "test",
                "Core.Tests",
                "Baselines",
                "syntax-child-source-order-inversions.txt"
            ),
            string.Join("\n", found) + "\n",
            "A syntax node has children that are not in source order in a new shape. If the new shape is " +
                "expected, regenerate with GSHARP_UPDATE_GOLDENS=1."
        )
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

        private func LocateRepoRoot() string {
            for var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory); dir != nil; dir = dir!!.Parent {
                if Directory.Exists(Path.Combine(dir.FullName, "test", "Core.Tests", "Baselines")) {
                    return dir.FullName
                }
            }
            throw InvalidOperationException("repository root not found from " + AppContext.BaseDirectory)
        }
    }
}
