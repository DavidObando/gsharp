// <copyright file="Issue5276ChildSingleEnumerationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #5276: a node lists each child once. The package, import and property declarations
/// exposed one identifier token through two child properties, so `GetChildren` returned it twice.
open class Issue5276ChildSingleEnumerationTests {
    /// No node of the corpus returns the same child instance twice from `GetChildren`.
    @Fact
    func GetChildren_NeverReturnsOneInstanceTwice_OnCorpus() {
        let found = SortedSet[string](StringComparer.Ordinal)
        var nodes = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                nodes++
                let seen = HashSet[SyntaxNode](ReferenceEqualityComparer.Instance)
                for child in node.GetChildren() {
                    if !seen.Add(child) {
                        found.Add("${node.GetType().Name}: ${child.Kind}")
                    }
                }
            }
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
        Assert.True(
            found.Count == 0,
            "Children returned twice (${found.Count} shapes):\n" + string.Join("\n", found)
        )
    }

    @Fact
    func PackageDeclaration_ListsEachTokenOnce() {
        let tree = SyntaxTree.Parse("package a.b.c\n")
        let package_ = Descendants(tree.Root).OfType[PackageSyntax]().First()
        Assert.Equal("package a . b . c", Leaves(package_))
        Assert.Equal(6, package_.ChildCount)
        Assert.Equal(3, package_.Identifiers.Length)
        Assert.Equal(5, package_.IdentifiersWithDots.Length)
    }

    @Fact
    func ImportDeclaration_ListsEachTokenOnce() {
        let tree = SyntaxTree.Parse("package p\nimport System.Collections.Generic\nimport L = System.Linq\n")
        let imports = Descendants(tree.Root).OfType[ImportSyntax]().ToList()
        Assert.Equal(2, imports.Count)
        Assert.Equal("import System . Collections . Generic", Leaves(imports[0]))
        Assert.Equal(6, imports[0].ChildCount)
        Assert.Equal("import L = System . Linq", Leaves(imports[1]))
        Assert.Equal(6, imports[1].ChildCount)
    }

    @Fact
    func PropertyDeclaration_ListsTheNameOnce() {
        let tree = SyntaxTree.Parse("package p\nclass A {\n    prop P int32 { get; }\n}\n")
        let property = Descendants(tree.Root).OfType[PropertyDeclarationSyntax]().First()
        let names = CountTokens(property, "P")
        Assert.Equal(1, names)
        Assert.Equal(property.ChildCount, property.GetChildren().Count())
    }

    @Fact
    func IndexerDeclaration_ListsTheThisKeywordOnce() {
        let tree = SyntaxTree.Parse("package p\nclass A {\n    prop this[i int32] int32 { get -> i }\n}\n")
        let property = Descendants(tree.Root).OfType[PropertyDeclarationSyntax]().First()
        Assert.True(property.IsIndexer)
        let thises = CountTokens(property, "this")
        Assert.Equal(1, thises)
    }

    private func CountTokens(node SyntaxNode, text string) int32 {
        var count = 0
        for child in node.GetChildren() {
            if child is SyntaxToken token && token.Text == text {
                count++
            }
        }
        return count
    }

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
}
