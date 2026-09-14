// <copyright file="Issue3785MixedCompositeInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3785: parser regression coverage for mixed composite initializers
/// (ADR-0180). A struct/class composite literal's <see cref="StructLiteralExpressionSyntax.Elements"/>
/// is one ordered list mixing <see cref="FieldInitializerSyntax"/> members
/// with <see cref="StructLiteralContentElementSyntax"/> bare/spread content
/// elements, replacing the pre-ADR-0180 members-only list for this shape.
/// </summary>
public class Issue3785MixedCompositeInitializerParserTests
{
    private static StructLiteralExpressionSyntax ParseLiteral(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Last();

        return Assert.IsType<StructLiteralExpressionSyntax>(varDecl.Initializer);
    }

    [Fact]
    public void MembersOnly_StillParsesEntirelyAsFieldInitializers()
    {
        // Regression: a plain literal with no content elements keeps
        // Elements entirely FieldInitializerSyntax, and Initializers mirrors
        // it exactly (ADR-0180 must not disturb the pre-existing shape).
        var literal = ParseLiteral(@"
let p = Point{ X: 1, Y: 2 }
");
        Assert.Equal(2, literal.Elements.Count);
        Assert.All(literal.Elements, e => Assert.IsType<FieldInitializerSyntax>(e));
        Assert.Equal(2, literal.Initializers.Count);
        Assert.Equal("X", literal.Initializers[0].FieldIdentifier.Text);
        Assert.Equal("Y", literal.Initializers[1].FieldIdentifier.Text);
    }

    [Fact]
    public void MixedMembersElementsAndSpread_ParseInLexicalOrder()
    {
        var literal = ParseLiteral(@"
let c = Container{ Width: 320.0, Text(""Account""), ...rows, Height: 10.0 }
");
        Assert.Equal(4, literal.Elements.Count);

        var width = Assert.IsType<FieldInitializerSyntax>(literal.Elements[0]);
        Assert.Equal("Width", width.FieldIdentifier.Text);

        var bare = Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[1]);
        Assert.IsType<CallExpressionSyntax>(bare.Expression);

        var spread = Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[2]);
        Assert.IsType<SpreadElementExpressionSyntax>(spread.Expression);

        var height = Assert.IsType<FieldInitializerSyntax>(literal.Elements[3]);
        Assert.Equal("Height", height.FieldIdentifier.Text);

        // The member-only filtered view keeps just Width/Height, in order.
        Assert.Equal(2, literal.Initializers.Count);
        Assert.Equal("Width", literal.Initializers[0].FieldIdentifier.Text);
        Assert.Equal("Height", literal.Initializers[1].FieldIdentifier.Text);
    }

    [Fact]
    public void LeadingStructuralSpread_NoParens_StaysAdr0148_NoContentElements()
    {
        // A leading `...source` with no explicit call parens remains
        // ADR-0148 structural projection: SpreadExpression is set, and
        // Elements holds only the (member-only) explicit overrides — never a
        // StructLiteralContentElementSyntax.
        var literal = ParseLiteral(@"
let p = Target{ ...source, Name: ""z"" }
");
        Assert.NotNull(literal.SpreadExpression);
        Assert.Single(literal.Elements);
        var member = Assert.IsType<FieldInitializerSyntax>(literal.Elements[0]);
        Assert.Equal("Name", member.FieldIdentifier.Text);
    }

    [Fact]
    public void BareContentElement_First_IsNotAStructLiteral()
    {
        // Unchanged ADR-0117 disambiguation: a bare-element-first brace after
        // explicit empty parens is a CollectionInitializerExpressionSyntax,
        // not a StructLiteralExpressionSyntax — ADR-0180 does not touch this
        // classification rule.
        var tree = SyntaxTree.Parse(@"
let c = Container(){ Text(""Account""), ...rows }
");
        Assert.Empty(tree.Diagnostics);
        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        Assert.IsType<CollectionInitializerExpressionSyntax>(varDecl.Initializer);
    }

    [Fact]
    public void ExplicitEmptyParens_LeadingSpreadThenMember_IsACompositeLiteral()
    {
        // ADR-0180 §B's explicit-parens marker: a leading `...source` under
        // explicit empty call parens, followed by a real member, promotes the
        // literal from an ADR-0117 collection initializer to a composite
        // literal whose first Elements entry is a content spread.
        var literal = ParseLiteral(@"
let c = Container(){ ...rows, Width: 320.0, Text(""Account"") }
");
        Assert.NotNull(literal.OpenParenToken);
        Assert.NotNull(literal.CloseParenToken);
        Assert.Null(literal.SpreadExpression);
        Assert.Equal(3, literal.Elements.Count);

        var spread = Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[0]);
        Assert.IsType<SpreadElementExpressionSyntax>(spread.Expression);

        var width = Assert.IsType<FieldInitializerSyntax>(literal.Elements[1]);
        Assert.Equal("Width", width.FieldIdentifier.Text);

        var bare = Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[2]);
        Assert.IsType<CallExpressionSyntax>(bare.Expression);
    }

    [Fact]
    public void ExplicitEmptyParens_LeadingSpreadOnly_NoMember_StaysAdr0117CollectionInitializer()
    {
        // Regression: with no later member, `Type(){ ...source }` keeps its
        // pre-ADR-0180 ADR-0117 collection-initializer meaning, unchanged.
        var tree = SyntaxTree.Parse(@"
let c = Container(){ ...rows }
");
        Assert.Empty(tree.Diagnostics);
        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        Assert.IsType<CollectionInitializerExpressionSyntax>(varDecl.Initializer);
    }

    [Fact]
    public void ExplicitEmptyParens_LeadingSpreadThenMember_GenericTarget_IsACompositeLiteral()
    {
        // The same marker applies to a generic construction target
        // (`Type[T](){ ...source, Member: value }`), reached through the same
        // MaybeWrapWithObjectInitializer dispatch as the non-generic form.
        var literal = ParseLiteral(@"
let c = Container[int32](){ ...rows, Width: 320.0 }
");
        Assert.NotNull(literal.OpenParenToken);
        Assert.Equal(2, literal.Elements.Count);
        Assert.IsType<StructLiteralContentElementSyntax>(literal.Elements[0]);
        var width = Assert.IsType<FieldInitializerSyntax>(literal.Elements[1]);
        Assert.Equal("Width", width.FieldIdentifier.Text);
    }
}
