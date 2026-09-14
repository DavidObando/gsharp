// <copyright file="Issue3785MixedCompositeInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>ADR-0180: operation selection is syntactic, with one ordered element list.</summary>
public class Issue3785MixedCompositeInitializerParserTests
{
    [Fact]
    public void MembersOnly_StillParsesEntirelyAsFieldInitializers()
    {
        var literal = Parse<StructLiteralExpressionSyntax>("let p = Point{ X: 1, Y: 2 }");
        Assert.Equal(2, literal.Elements.Count);
        Assert.All(literal.Elements, element => Assert.IsType<FieldInitializerSyntax>(element));
        Assert.Equal(2, literal.Initializers.Count);
        Assert.Equal("X", literal.Initializers[0].FieldIdentifier.Text);
        Assert.Equal("Y", literal.Initializers[1].FieldIdentifier.Text);
    }

    [Fact]
    public void MixedMembersElementsAndSpread_ParseInLexicalOrder()
    {
        var literal = Parse<StructLiteralExpressionSyntax>("""
            let c = Container{ Width: 320.0, Text("Account"), ...rows, Height: 10.0 }
            """);
        Assert.Equal(4, literal.Elements.Count);
        Assert.Equal("Width", Assert.IsType<FieldInitializerSyntax>(literal.Elements[0]).FieldIdentifier.Text);
        Assert.IsType<CallExpressionSyntax>(Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[1]).Expression);
        Assert.IsType<SpreadElementExpressionSyntax>(Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[2]).Expression);
        Assert.Equal("Height", Assert.IsType<FieldInitializerSyntax>(literal.Elements[3]).FieldIdentifier.Text);
        Assert.Equal(new[] { "Width", "Height" }, literal.Initializers.Select(member => member.FieldIdentifier.Text));
    }

    [Fact]
    public void LeadingStructuralSpread_NoParens_StaysAdr0148_NoContentElements()
    {
        var literal = Parse<StructLiteralExpressionSyntax>("""let p = Target{ ...source, Name: "z" }""");
        Assert.NotNull(literal.SpreadExpression);
        Assert.Equal("Name", Assert.IsType<FieldInitializerSyntax>(Assert.Single(literal.Elements)).FieldIdentifier.Text);
    }

    [Theory]
    [InlineData("""Container(){ Text("Account"), ...rows }""")]
    [InlineData("Container(){ ...rows }")]
    public void BareOrSpreadFirst_StaysACollectionInitializer(string expression)
    {
        Parse<CollectionInitializerExpressionSyntax>("let c = " + expression);
    }

    [Theory]
    [InlineData("Container()", 0, 0)]
    [InlineData("Container(7)", 1, 0)]
    [InlineData("Container[int32](7)", 1, 1)]
    [InlineData("makeContainer()", 0, 0)]
    public void ExplicitMember_RetainsCallArgumentsAndLexicalOrder(string target, int argumentCount, int typeArgumentCount)
    {
        var literal = Parse<CollectionInitializerExpressionSyntax>(
            "let c = " + target + """{ ...rows, .Width: 320.0, Text("Account") }""");
        var call = Assert.IsType<CallExpressionSyntax>(literal.Target);
        Assert.Equal(argumentCount, call.Arguments.Count);
        Assert.Equal(typeArgumentCount, call.TypeArgumentList?.Arguments.Count ?? 0);
        Assert.Equal(3, literal.Elements.Count);
        Assert.IsType<SpreadElementExpressionSyntax>(Assert.IsType<ExpressionCollectionElementSyntax>(literal.Elements[0]).Expression);
        var width = Assert.IsType<MemberCollectionElementSyntax>(literal.Elements[1]);
        Assert.Equal("Width", width.Initializer.FieldIdentifier.Text);
        Assert.Equal(SyntaxKind.DotToken, width.DotToken.Kind);
        Assert.IsType<CallExpressionSyntax>(Assert.IsType<ExpressionCollectionElementSyntax>(literal.Elements[2]).Expression);
    }

    [Fact]
    public void ExplicitMember_First_DoesNotReclassifyKeyedOrIndexedEntries()
    {
        var literal = Parse<CollectionInitializerExpressionSyntax>("""
            let c = Bag(){ .Capacity: 10, ...rows, Capacity: 2, "c": 3, [key] = 4, item, }
            """);
        Assert.Collection(
            literal.Elements,
            element => Assert.IsType<MemberCollectionElementSyntax>(element),
            element => Assert.IsType<ExpressionCollectionElementSyntax>(element),
            element => Assert.IsType<KeyedCollectionElementSyntax>(element),
            element => Assert.IsType<KeyedCollectionElementSyntax>(element),
            element => Assert.IsType<IndexedCollectionElementSyntax>(element),
            element => Assert.IsType<ExpressionCollectionElementSyntax>(element));
        Assert.Equal(12, literal.Elements.GetWithSeparators().Length);
    }

    [Theory]
    [InlineData("makeMap()")]
    [InlineData("Dictionary[string, int32]()")]
    public void LeadingSpreadThenUnmarkedKeys_RemainsACollectionInitializer(string target)
    {
        var literal = Parse<CollectionInitializerExpressionSyntax>(
            "let m = " + target + """{ ...pairs, key: 2, "c": 3, [key] = 4 }""");
        Assert.IsType<KeyedCollectionElementSyntax>(literal.Elements[1]);
        Assert.IsType<KeyedCollectionElementSyntax>(literal.Elements[2]);
        Assert.IsType<IndexedCollectionElementSyntax>(literal.Elements[3]);
    }

    [Fact]
    public void MembersOnly_TrailingComma_InitializersKeepsFinalSeparator()
    {
        var literal = Parse<StructLiteralExpressionSyntax>("let p = Point{ X: 1, Y: 2, }");
        var raw = literal.Initializers.GetWithSeparators();
        Assert.Equal(literal.Elements.GetWithSeparators().ToArray(), raw.ToArray());
        Assert.Equal(4, raw.Length);
        Assert.Equal(SyntaxKind.CommaToken, Assert.IsType<SyntaxToken>(raw[3]).Kind);
    }

    [Theory]
    [InlineData(".")]
    [InlineData(".Cap")]
    [InlineData(".Capacity:")]
    public void IncompleteExplicitMember_RetainsInitializerContext(string entry)
    {
        var tree = SyntaxTree.Parse("let c = Bag(){ " + entry + " }");
        Assert.NotEmpty(tree.Diagnostics);
        var declaration = Assert.IsType<VariableDeclarationSyntax>(
            Assert.IsType<GlobalStatementSyntax>(tree.Root.Members.Single()).Statement);
        var initializer = Assert.IsType<CollectionInitializerExpressionSyntax>(declaration.Initializer);
        Assert.IsType<MemberCollectionElementSyntax>(Assert.Single(initializer.Elements));
    }

    private static T Parse<T>(string source)
        where T : ExpressionSyntax
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Last();
        return Assert.IsType<T>(declaration.Initializer);
    }
}
