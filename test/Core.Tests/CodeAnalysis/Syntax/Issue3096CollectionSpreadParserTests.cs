// <copyright file="Issue3096CollectionSpreadParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for native array/collection ellipsis spreads.</summary>
public sealed class Issue3096CollectionSpreadParserTests
{
    [Fact]
    public void ArrayLiteral_ParsesFixedAndMultipleSpreadElements()
    {
        var expression = ParseInitializer("[]int32{ 0, ...first, ...second, 9 }");
        var array = Assert.IsType<ArrayCreationExpressionSyntax>(expression);

        Assert.Equal(4, array.Elements.Count);
        Assert.IsType<LiteralExpressionSyntax>(array.Elements[0]);
        Assert.Equal(
            "first",
            Assert.IsType<NameExpressionSyntax>(
                Assert.IsType<SpreadElementExpressionSyntax>(array.Elements[1]).Expression)
                .IdentifierToken.Text);
        Assert.Equal(
            "second",
            Assert.IsType<NameExpressionSyntax>(
                Assert.IsType<SpreadElementExpressionSyntax>(array.Elements[2]).Expression)
                .IdentifierToken.Text);
        Assert.IsType<LiteralExpressionSyntax>(array.Elements[3]);
    }

    [Fact]
    public void CollectionInitializer_ExplicitCtorParsesSpread()
    {
        var expression = ParseInitializer("List[int32](){ 0, ...items, 9 }");
        var collection = Assert.IsType<CollectionInitializerExpressionSyntax>(expression);
        var spreadElement = Assert.IsType<ExpressionCollectionElementSyntax>(collection.Elements[1]);
        var spread = Assert.IsType<SpreadElementExpressionSyntax>(spreadElement.Expression);

        Assert.Equal("...", spread.EllipsisToken.Text);
        Assert.Equal("items", Assert.IsType<NameExpressionSyntax>(spread.Expression).IdentifierToken.Text);
    }

    [Fact]
    public void GenericStructLiteral_LeadingEllipsisRemainsStructuralSpread()
    {
        var expression = ParseInitializer("Box[int32]{ ...source }");
        var literal = Assert.IsType<StructLiteralExpressionSyntax>(expression);

        Assert.NotNull(literal.SpreadToken);
        Assert.Equal("source", Assert.IsType<NameExpressionSyntax>(literal.SpreadExpression).IdentifierToken.Text);
    }

    [Fact]
    public void DotDotRangeElement_RemainsRangeExpression()
    {
        var expression = ParseInitializer("List[Range](){ ..3 }");
        var collection = Assert.IsType<CollectionInitializerExpressionSyntax>(expression);
        var element = Assert.IsType<ExpressionCollectionElementSyntax>(Assert.Single(collection.Elements));

        Assert.IsType<RangeExpressionSyntax>(element.Expression);
    }

    private static ExpressionSyntax ParseInitializer(string initializer)
    {
        var tree = SyntaxTree.Parse($"""
            import System
            import System.Collections.Generic
            let value = {initializer}
            """);
        Assert.Empty(tree.Diagnostics);

        return tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single()
            .Initializer;
    }
}
