// <copyright file="Issue3096CollectionSpreadParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser coverage for native array/collection ellipsis spreads.
class Issue3096CollectionSpreadParserTests {
    @Fact
    func ArrayLiteral_ParsesFixedAndMultipleSpreadElements() {
        let expression ExpressionSyntax? = ParseInitializer("[]int32{ 0, ...first, ...second, 9 }")
        let array = Assert.IsType[ArrayCreationExpressionSyntax](expression)
        Assert.Equal(4, array.Elements!!.Count)
        Assert.IsType[LiteralExpressionSyntax](array.Elements!![0])
        Assert.Equal(
            "first",
            Assert
                .IsType[NameExpressionSyntax](
                Assert.IsType[SpreadElementExpressionSyntax](array.Elements!![1]).Expression
            )
                .IdentifierToken
                .Text
        )
        Assert.Equal(
            "second",
            Assert
                .IsType[NameExpressionSyntax](
                Assert.IsType[SpreadElementExpressionSyntax](array.Elements!![2]).Expression
            )
                .IdentifierToken
                .Text
        )
        Assert.IsType[LiteralExpressionSyntax](array.Elements!![3])
    }

    @Fact
    func CollectionInitializer_ExplicitCtorParsesSpread() {
        let expression ExpressionSyntax? = ParseInitializer("List[int32](){ 0, ...items, 9 }")
        let collection = Assert.IsType[CollectionInitializerExpressionSyntax](expression)
        let spreadElement = Assert.IsType[ExpressionCollectionElementSyntax](collection.Elements[1])
        let spread = Assert.IsType[SpreadElementExpressionSyntax](spreadElement.Expression)
        Assert.Equal("...", spread.EllipsisToken.Text)
        Assert.Equal("items", Assert.IsType[NameExpressionSyntax](spread.Expression).IdentifierToken.Text)
    }

    @Fact
    func GenericStructLiteral_LeadingEllipsisRemainsStructuralSpread() {
        let expression ExpressionSyntax? = ParseInitializer("Box[int32]{ ...source }")
        let literal = Assert.IsType[StructLiteralExpressionSyntax](expression)
        Assert.NotNull(literal.SpreadToken)
        Assert.Equal("source", Assert.IsType[NameExpressionSyntax](literal.SpreadExpression).IdentifierToken.Text)
    }

    @Fact
    func DotDotRangeElement_RemainsRangeExpression() {
        let expression ExpressionSyntax? = ParseInitializer("List[Range](){ ..3 }")
        let collection = Assert.IsType[CollectionInitializerExpressionSyntax](expression)
        let element = Assert.IsType[ExpressionCollectionElementSyntax](Assert.Single(collection.Elements))
        Assert.IsType[RangeExpressionSyntax](element.Expression)
    }

    shared {
        private func ParseInitializer(initializer string) ExpressionSyntax? {
            let tree = SyntaxTree.Parse((`import System
import System.Collections.Generic
let value = ` + "$initializer"))
            Assert.Empty(tree.Diagnostics)
            return tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((member GlobalStatementSyntax) -> member.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
                .Initializer
        }
    }
}
