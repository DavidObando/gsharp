// <copyright file="Issue4080ForClauseBraceExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4080: a C-style `for` condition is terminated by its second
/// semicolon, so braces inside that expression must not be mistaken for the
/// loop body.
class Issue4080ForClauseBraceExpressionParserTests {
    @Fact
    func EmptyPropertyPatternInConditionParsesBeforeSemicolon() {
        const source = `package p
class Node { var Next Node? }
class C {
    func F(current Node) {
        for var steps = 0; steps < 64 && current.Next is { } next; steps++ {
            current = next
        }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let statement = Descendants(tree.Root).OfType[ForClauseStatementSyntax]().Single()
        let pattern = Descendants(statement.Condition).OfType[PropertyPatternSyntax]().Single()
        Assert.Empty(pattern.Fields)
        Assert.Equal("next", pattern.Designation?.Text)
        Assert.IsType[BlockStatementSyntax](statement.Body)
    }

    @Fact
    func ObjectInitializerInConditionParsesBeforeSemicolon() {
        const source = `package p
class Box { var Value int32 }
class C {
    func F() {
        for var i = 0; Box() { Value = i }.Value < 4; i++ { }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let statement = Descendants(tree.Root).OfType[ForClauseStatementSyntax]().Single()
        Assert.Contains(Descendants(statement.Condition), (node SyntaxNode) -> node is ObjectCreationExpressionSyntax)
        Assert.IsType[BlockStatementSyntax](statement.Body)
    }

    shared {
        private func Descendants(node SyntaxNode?) sequence[SyntaxNode] {
            for child in node!!.GetChildren() {
                yield child
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}
