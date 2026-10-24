// <copyright file="Issue5185ChildSourceOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #5185: `GetChildren` yields the children of every node in source order. These tests run
/// on every node of the corpus (the snippets and `samples/**/*.gs`) and on small exact cases.
open class Issue5185ChildSourceOrderTests {
    /// The start of each child is not before the start of the previous child, for every node of the
    /// corpus. A failure lists each (node class, previous child kind, next child kind) shape.
    @Fact
    func ChildStarts_NeverGoBackward_OnCorpus() {
        let found = SortedSet[string](StringComparer.Ordinal)
        var nodes = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                nodes++
                var previous SyntaxNode? = nil
                for child in node.GetChildren() {
                    if previous != nil && child.Span.Start < previous.Span.Start {
                        found.Add("${node.GetType().Name}: ${previous.Kind} -> ${child.Kind}")
                    }
                    previous = child
                }
            }
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
        Assert.True(
            found.Count == 0,
            "Children out of source order (${found.Count} shapes):\n" + string.Join("\n", found)
        )
    }

    /// Children can still overlap in order. This is not an ordering defect. A synthesized token
    /// (an expression body's `return`, the braces of a body-less type) shares a position with a
    /// real one. An interpolated string token contains its holes. Two properties can return one
    /// token. This test records each such shape so a new one is reviewed. Regenerate with
    /// GSHARP_UPDATE_GOLDENS=1.
    @Fact
    func ChildOverlaps_MatchTheRecordedShapes() {
        let found = SortedSet[string](StringComparer.Ordinal)
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                var previous SyntaxNode? = nil
                for child in node.GetChildren() {
                    if previous != nil && child.Span.Start < previous.Span.End {
                        let reason = if object.ReferenceEquals(previous, child) {
                            "same instance twice"
                        } else if child.Span.End <= previous.Span.End {
                            "contained in the previous child"
                        } else {
                            "partial overlap"
                        }
                        found.Add("${node.GetType().Name}: ${previous.Kind} -> ${child.Kind} (${reason})")
                    }
                    previous = child
                }
            }
        }
        GoldenFile.AssertMatches(
            Path.Combine(LocateRepoRoot(), "test", "Core.Tests", "Baselines", "syntax-child-overlaps.txt"),
            string.Join("\n", found) + "\n",
            "A syntax node has overlapping children in a new shape. If the new shape is expected, " +
                "regenerate with GSHARP_UPDATE_GOLDENS=1."
        )
    }

    /// A postfix `!!` follows its operand, so it is the last token of the expression.
    @Fact
    func PostfixUnary_ListsTheOperandBeforeTheOperator() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32?) int32 { return x!! }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        Assert.Equal("x !!", Leaves(unary))
        Assert.Equal("x", unary.GetFirstToken().Text)
        Assert.Equal("!!", unary.GetLastToken().Text)
    }

    /// A prefix operator stays first.
    @Fact
    func PrefixUnary_ListsTheOperatorFirst() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32) int32 { return -x }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        Assert.Equal("- x", Leaves(unary))
    }

    /// The forms of a type clause list their tokens in the order they are written.
    @Fact
    func TypeClauseForms_ListTheirTokensInSourceOrder() {
        let tree = SyntaxTree.Parse(
            "package p\nfunc F(a string?, b []int32, c (int32, int32) -> int32, d map[string, int32]) { }\n"
        )
        let clauses = Descendants(tree.Root).OfType[ParameterSyntax]().Select((p ParameterSyntax) -> p.Type!!).ToList()
        Assert.Equal(4, clauses.Count)
        Assert.Equal("string ?", Leaves(clauses[0]))
        Assert.Equal("[ ] int32", Leaves(clauses[1]))
        Assert.Equal("( int32 , int32 ) -> int32", Leaves(clauses[2]))
        Assert.Equal("map [ string , int32 ]", Leaves(clauses[3]))
    }

    /// A struct lists fields, methods, nested types and the shared block where they are written.
    @Fact
    func StructBody_ListsMembersInSourceOrder() {
        let tree = SyntaxTree.Parse(
            "package p\nclass A {\n    var a int32\n    func F() { }\n    shared {\n        var s int32 = 1\n    }\n    var b int32\n    class Inner { }\n}\n"
        )
        let type = Descendants(tree.Root).OfType[StructDeclarationSyntax]().First()
        Assert.Equal(
            "class A { var a int32 func F ( ) { } shared { var s int32 = 1 } var b int32 class Inner { } }",
            Leaves(type)
        )
        Assert.Equal("class", type.GetFirstToken().Text)
        Assert.Equal("}", type.GetLastToken().Text)
    }

    /// Annotations and modifiers come before the `func` keyword, and the return type is last.
    @Fact
    func FunctionDeclaration_ListsAnnotationsAndModifiersFirst() {
        let tree = SyntaxTree.Parse("package p\n@Obsolete\nprivate func F() int32 { return 1 }\n")
        let function = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().First()
        Assert.Equal("@ Obsolete private func F ( ) int32 { return 1 }", Leaves(function))
        Assert.Equal("@", function.GetFirstToken().Text)
    }

    /// A receiver in parentheses follows the `func` keyword.
    @Fact
    func MethodWithReceiver_ListsTheKeywordBeforeTheReceiver() {
        let tree = SyntaxTree.Parse("package p\nfunc (v int32) Scale(f int32) int32 { return v * f }\n")
        let function = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().First()
        Assert.Equal("func ( v int32 ) Scale ( f int32 ) int32 { return v * f }", Leaves(function))
    }

    /// Reflection and the generated accessors order the children the same way.
    @Fact
    func ReflectionOracle_UsesTheSameOrder() {
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                Assert.True(
                    node.GetChildren().SequenceEqual(node.GetChildrenByReflection()),
                    "${node.GetType().Name} children differ from the reflection order"
                )
            }
        }
    }

    shared {
        /// Returns the texts of the leaf tokens of a node, in the order of `GetChildren`.
        private func Leaves(node SyntaxNode) string {
            let texts = List[string]()
            AddLeaves(node, texts)
            return string.Join(" ", texts)
        }

        private func AddLeaves(node SyntaxNode, texts List[string]) {
            if node is SyntaxToken token {
                texts.Add(token.Text)
                return
            }
            for child in node.GetChildren() {
                AddLeaves(child, texts)
            }
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
