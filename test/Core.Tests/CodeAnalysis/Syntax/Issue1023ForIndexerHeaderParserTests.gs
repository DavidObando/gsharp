// <copyright file="Issue1023ForIndexerHeaderParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1023: a C-style `for` whose increment (or condition) ends in an
/// indexer (`expr[i]`) immediately before the body `{` must bind the
/// `[i]` as an indexer and let `{` open the loop body — it must NOT
/// be mis-parsed as the generic-composite literal shape `name[args] { … }`.
///
/// The shared Go-style suppression that already blocks `Type { … }` and
/// `Call() { … }` in statement-header controlling expressions
/// (`if`/`while`/`for` clauses, `switch`/`match`
/// subject) is now also honoured by `LooksLikeGenericCallSite` for the
/// trailing `{` follow-set marker. These tests lock that contract in at
/// the parser layer and guard against regressing legitimate composite-literal
/// parsing in expression position.
open class Issue1023ForIndexerHeaderParserTests {
    @Fact
    func ForClause_Post_Ending_In_Indexer_Parses_Without_Diagnostics() {
        // The canonical repro from the issue.
        const source = `
package p
class C { func F(arr []int32) { for var s = 0; s < arr.Length; s += arr[s] { var x = 1 } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let forClause = Descendants(tree.Root).OfType[ForClauseStatementSyntax]().Single()
        // The post must be `s += arr[s]` (an indexer-tailed assignment), and the
        // body must be a real block — not swallowed by a composite literal.
        Assert.NotNull(forClause.Post)
        Assert.IsType[BlockStatementSyntax](forClause.Body)
        // No part of the header may have been reinterpreted as a struct literal.
        Assert.Empty(Descendants(forClause.Post).OfType[StructLiteralExpressionSyntax]())
        Assert.Contains(Descendants(forClause.Post), (n SyntaxNode) -> n is IndexExpressionSyntax)
    }

    @Fact
    func ForClause_Condition_Ending_In_Indexer_Parses_Without_Diagnostics() {
        const source = `
package p
class C { func F(arr []int32) { for var i = 0; arr[i] > 0; i = i + 1 { break } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let forClause = Descendants(tree.Root).OfType[ForClauseStatementSyntax]().Single()
        Assert.IsType[BlockStatementSyntax](forClause.Body)
        Assert.Contains(Descendants(forClause.Condition), (n SyntaxNode) -> n is IndexExpressionSyntax)
    }

    @Fact
    func ForCondition_Form_Ending_In_Indexer_Parses_Without_Diagnostics() {
        // The condition-only `for cond { … }` form whose condition ends in an
        // indexer must also let `{` open the body.
        const source = `
package p
class C { func F(arr []bool) { for arr[0] { break } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let forCond = Descendants(tree.Root).OfType[ForConditionStatementSyntax]().Single()
        Assert.IsType[BlockStatementSyntax](forCond.Body)
    }

    @Fact
    func If_With_Indexer_Tailed_Condition_Parses_Without_Diagnostics() {
        const source = `
package p
class C { func F(arr []int32) { if arr[0] > 0 { var x = 1 } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func While_With_Indexer_Tailed_Condition_Parses_Without_Diagnostics() {
        const source = `
package p
class C { func F(arr []int32) { while arr[0] > 0 { break } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericCompositeLiteral_In_Expression_Position_Still_Parses_As_StructLiteral() {
        // Regression guard: the suppression must apply ONLY in statement-header
        // controlling-expression contexts. In ordinary expression position a
        // `name[args] { … }` shape is still a generic composite literal.
        const source = `
package p
class Box[T] { var Value T }
class C { func F() { var b = Box[int32]{Value: 42} } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Box", structLiteral.TypeIdentifier.Text)
        Assert.NotNull(structLiteral.TypeArgumentList)
        Assert.Single(structLiteral.Initializers)
    }

    @Fact
    func BareStructLiteral_In_Expression_Position_Still_Parses() {
        const source = `
package p
class Point { var X int32
 var Y int32 }
class C { func F() { var p = Point{X: 1, Y: 2} } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Point", structLiteral.TypeIdentifier.Text)
        Assert.Equal(2, structLiteral.Initializers.Count)
    }

    shared {
        private func Descendants(node SyntaxNode?) sequence[SyntaxNode] {
            for child in node!!.GetChildren() {
                yield child
                for d in Descendants(child) {
                    yield d
                }
            }
        }
    }
}
