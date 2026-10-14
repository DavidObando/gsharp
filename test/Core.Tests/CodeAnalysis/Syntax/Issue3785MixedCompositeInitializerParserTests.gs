// <copyright file="Issue3785MixedCompositeInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0180: operation selection is syntactic, with one ordered element list.
open class Issue3785MixedCompositeInitializerParserTests {
    @Fact
    func MembersOnly_StillParsesEntirelyAsFieldInitializers() {
        let literal = Parse[StructLiteralExpressionSyntax]("let p = Point{ X: 1, Y: 2 }")
        Assert.Equal(2, literal.Elements.Count)
        Assert.All(
            literal.Elements,
            (element StructLiteralElementSyntax) -> Assert.IsType[FieldInitializerSyntax](element)
        )
        Assert.Equal(2, literal.Initializers.Count)
        Assert.Equal("X", literal.Initializers[0].FieldIdentifier.Text)
        Assert.Equal("Y", literal.Initializers[1].FieldIdentifier.Text)
    }

    @Fact
    func MixedMembersElementsAndSpread_ParseInLexicalOrder() {
        let literal = Parse[StructLiteralExpressionSyntax](
            "let c = Container{ Width: 320.0, Text(\"Account\"), ...rows, Height: 10.0 }"
        )
        Assert.Equal(4, literal.Elements.Count)
        Assert.Equal("Width", Assert.IsType[FieldInitializerSyntax](literal.Elements[0]).FieldIdentifier.Text)
        Assert.IsType[CallExpressionSyntax](
            Assert.IsType[StructLiteralContentElementSyntax](literal.Elements[1]).Expression
        )
        Assert.IsType[SpreadElementExpressionSyntax](
            Assert.IsType[StructLiteralContentElementSyntax](literal.Elements[2]).Expression
        )
        Assert.Equal("Height", Assert.IsType[FieldInitializerSyntax](literal.Elements[3]).FieldIdentifier.Text)
        Assert.Equal(
            []string{"Width", "Height"},
            literal.Initializers.Select((member FieldInitializerSyntax) -> member.FieldIdentifier.Text)
        )
    }

    @Fact
    func LeadingStructuralSpread_NoParens_StaysAdr0148_NoContentElements() {
        let literal = Parse[StructLiteralExpressionSyntax]("let p = Target{ ...source, Name: \"z\" }")
        Assert.NotNull(literal.SpreadExpression)
        Assert.Equal(
            "Name",
            Assert.IsType[FieldInitializerSyntax](Assert.Single(literal.Elements)).FieldIdentifier.Text
        )
    }

    @Theory
    @InlineData("Container(){ Text(\"Account\"), ...rows }")
    @InlineData("Container(){ ...rows }")
    func BareOrSpreadFirst_StaysACollectionInitializer(expression string) {
        Parse[CollectionInitializerExpressionSyntax]("let c = " + expression)
    }

    @Theory
    @InlineData("Container()", int32(0), int32(0))
    @InlineData("Container(7)", int32(1), int32(0))
    @InlineData("Container[int32](7)", int32(1), int32(1))
    @InlineData("makeContainer()", int32(0), int32(0))
    func ExplicitMember_RetainsCallArgumentsAndLexicalOrder(
        target string,
        argumentCount int32,
        typeArgumentCount int32
    ) {
        let literal = Parse[CollectionInitializerExpressionSyntax](
            "let c = " + target + "{ ...rows, .Width: 320.0, Text(\"Account\") }"
        )
        let call = Assert.IsType[CallExpressionSyntax](literal.Target)
        Assert.Equal(argumentCount, call.Arguments.Count)
        Assert.Equal(typeArgumentCount, call.TypeArgumentList?.Arguments.Count ?? 0)
        Assert.Equal(3, literal.Elements.Count)
        Assert.IsType[SpreadElementExpressionSyntax](
            Assert.IsType[ExpressionCollectionElementSyntax](literal.Elements[0]).Expression
        )
        let width = Assert.IsType[MemberCollectionElementSyntax](literal.Elements[1])
        Assert.Equal("Width", width.Initializer.FieldIdentifier.Text)
        Assert.Equal(SyntaxKind.DotToken, width.DotToken.Kind)
        Assert.IsType[CallExpressionSyntax](
            Assert.IsType[ExpressionCollectionElementSyntax](literal.Elements[2]).Expression
        )
    }

    @Fact
    func ExplicitMember_First_DoesNotReclassifyKeyedOrIndexedEntries() {
        let literal = Parse[CollectionInitializerExpressionSyntax](
            "let c = Bag(){ .Capacity: 10, ...rows, Capacity: 2, \"c\": 3, [key] = 4, item, }"
        )
        Assert.Collection(
            literal.Elements,
            (element CollectionElementSyntax) -> Assert.IsType[MemberCollectionElementSyntax](element),
            (element CollectionElementSyntax) -> Assert.IsType[ExpressionCollectionElementSyntax](element),
            (element CollectionElementSyntax) -> Assert.IsType[KeyedCollectionElementSyntax](element),
            (element CollectionElementSyntax) -> Assert.IsType[KeyedCollectionElementSyntax](element),
            (element CollectionElementSyntax) -> Assert.IsType[IndexedCollectionElementSyntax](element),
            (element CollectionElementSyntax) -> Assert.IsType[ExpressionCollectionElementSyntax](element)
        )
        Assert.Equal(12, literal.Elements.GetWithSeparators().Length)
    }

    @Theory
    @InlineData("makeMap()")
    @InlineData("Dictionary[string, int32]()")
    func LeadingSpreadThenUnmarkedKeys_RemainsACollectionInitializer(target string) {
        let literal = Parse[CollectionInitializerExpressionSyntax](
            "let m = " + target + "{ ...pairs, key: 2, \"c\": 3, [key] = 4 }"
        )
        Assert.IsType[KeyedCollectionElementSyntax](literal.Elements[1])
        Assert.IsType[KeyedCollectionElementSyntax](literal.Elements[2])
        Assert.IsType[IndexedCollectionElementSyntax](literal.Elements[3])
    }

    @Fact
    func MembersOnly_TrailingComma_InitializersKeepsFinalSeparator() {
        let literal = Parse[StructLiteralExpressionSyntax]("let p = Point{ X: 1, Y: 2, }")
        let raw = literal.Initializers.GetWithSeparators()
        Assert.Equal(literal.Elements.GetWithSeparators().ToArray(), raw.ToArray())
        Assert.Equal(4, raw.Length)
        Assert.Equal(SyntaxKind.CommaToken, Assert.IsType[SyntaxToken](raw[3]).Kind)
    }

    @Theory
    @InlineData(".")
    @InlineData(".Cap")
    @InlineData(".Capacity:")
    func IncompleteExplicitMember_RetainsInitializerContext(entry string) {
        let tree = SyntaxTree.Parse("let c = Bag(){ " + entry + " }")
        Assert.NotEmpty(tree.Diagnostics)
        let declaration = Assert.IsType[VariableDeclarationSyntax](
            Assert.IsType[GlobalStatementSyntax](tree.Root.Members.Single()).Statement
        )
        let initializer = Assert.IsType[CollectionInitializerExpressionSyntax](declaration.Initializer)
        Assert.IsType[MemberCollectionElementSyntax](Assert.Single(initializer.Elements))
    }

    shared {
        private func Parse[T ExpressionSyntax](source string) T {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let declaration = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((member GlobalStatementSyntax) -> member.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Last()
            return Assert.IsType[T](declaration.Initializer)
        }
    }
}
