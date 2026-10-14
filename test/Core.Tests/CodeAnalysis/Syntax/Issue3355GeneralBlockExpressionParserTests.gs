// <copyright file="Issue3355GeneralBlockExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3355: a block with a trailing expression is a primary expression,
/// not only a special lambda/if branch body.
open class Issue3355GeneralBlockExpressionParserTests {
    @Fact
    func GeneralExpressionPositions_ParseBlockExpressions() {
        const source = `package P

class Base {
    init(value int32) { }
}

class C : Base {
    var field int32 = { let x = 1 x }

    init(seed int32) : base({ let x = seed x }) {
        let local = { let x = seed + 1 x }
        consume({ let x = local + 1 x })
        let values = []int32{{ let x = 2 x }, 3}
        let nested = { let x = 4 { let y = x + 1 y } }
        let nestedLeft = { { let flag = true flag } ? 1 : 0 }
        let operand = 2 * { let x = 3 x }
        while let item = { let candidate = maybe candidate } { break }
        return { let x = operand + values[0] + nested x }
    }
}

func consume(value int32) { }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.True(Walk(tree.Root).OfType[BlockExpressionSyntax]().Count() >= 9)
    }

    @Fact
    func StatementBodiesAndLiteralBraces_KeepExistingSyntaxKinds() {
        const source = `package P

data struct Point {
    var X int32
}

func F(flag bool) {
    if flag {
        let p = Point{X: 1}
        let values = []int32{1, 2}
        let anon = object { let Value = p.X }
        if p is { X: 1 } { return }
        { let shadow = p.X }
    }

    switch flag {
        case true { return }
        default { return }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotEmpty(Walk(tree.Root).OfType[BlockStatementSyntax]())
        Assert.NotEmpty(Walk(tree.Root).OfType[StructLiteralExpressionSyntax]())
        Assert.NotEmpty(Walk(tree.Root).OfType[ArrayCreationExpressionSyntax]())
        Assert.NotEmpty(Walk(tree.Root).OfType[AnonymousClassExpressionSyntax]())
        Assert.NotEmpty(Walk(tree.Root).OfType[PropertyPatternSyntax]())
        Assert.Empty(Walk(tree.Root).OfType[BlockExpressionSyntax]())
    }

    @Fact
    func MissingTrailingExpression_RecoversAsBlockExpression() {
        const source = `package P
let value = { let x = 1 }
let after = 2`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let block = Assert.Single(Walk(tree.Root).OfType[BlockExpressionSyntax]())
        Assert.Single(block.Statements)
        Assert.Null(block.Expression)
        Assert.Contains(
            Walk(tree.Root).OfType[VariableDeclarationSyntax](),
            (declaration VariableDeclarationSyntax) -> declaration.Identifier.Text == "after"
        )
    }

    @Fact
    func LeadingBraceFollowedByExpressionContinuation_DoesNotBecomeStatementBlock() {
        const source = `package P

data struct Point {
    var X int32
}

func F(ch chan[int32]) {
    { let p = Point{X: 1} p } with { X = 2 }
    { let selected = ch selected } <- 42
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(2, Walk(tree.Root).OfType[BlockExpressionSyntax]().Count())
        Assert.Single(Walk(tree.Root).OfType[WithExpressionSyntax]())
        let send = Assert.Single(Walk(tree.Root).OfType[ChannelSendStatementSyntax]())
        Assert.IsType[BlockExpressionSyntax](send.Channel)
    }

    @Fact
    func StandaloneBlockAfterIndexedInitializer_RemainsStatementBlock() {
        const source = `package P

func F(values []int32) {
    for var i = 0; i < values.Length; i++ {
        let current = values[i]
        {
            let next = values[i]
            if i < values.Length && next is int32 && check(current) {
                continue
            }
        }
        if current > 0 {
            return
        }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(5, Walk(tree.Root).OfType[BlockStatementSyntax]().Count())
        Assert.Empty(Walk(tree.Root).OfType[BlockExpressionSyntax]())
    }

    shared {
        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Walk(child) {
                    yield descendant
                }
            }
        }
    }
}
