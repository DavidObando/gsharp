// <copyright file="PatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for Phase 6.2 switch patterns.</summary>
public class PatternParserTests
{
    [Theory]
    [InlineData("1", SyntaxKind.ConstantPattern)]
    [InlineData("_", SyntaxKind.DiscardPattern)]
    [InlineData("v is Foo", SyntaxKind.TypePattern)]
    [InlineData("{ Name: \"x\" }", SyntaxKind.PropertyPattern)]
    [InlineData("[1, _, 3]", SyntaxKind.ListPattern)]
    public void SwitchExpression_CaseValue_ParsesPattern(string pattern, SyntaxKind expectedKind)
    {
        var arm = ParseFirstSwitchExpressionArm($"let x = switch v {{ case {pattern}: 1 default: 0 }}");
        Assert.Equal(expectedKind, arm.Value.Kind);
    }

    [Theory]
    [InlineData("< 0")]
    [InlineData("<= 0")]
    [InlineData("> 0")]
    [InlineData(">= 0")]
    [InlineData("== 0")]
    [InlineData("!= 0")]
    public void SwitchExpression_RelationalPatterns_Parse(string pattern)
    {
        var arm = ParseFirstSwitchExpressionArm($"let x = switch v {{ case {pattern}: 1 default: 0 }}");
        Assert.Equal(SyntaxKind.RelationalPattern, arm.Value.Kind);
    }

    [Fact]
    public void SwitchExpression_PropertyPattern_ParsesMultipleAndNestedFields()
    {
        var arm = ParseFirstSwitchExpressionArm("let x = switch v { case { Name: \"x\", Child: { Name: \"y\" } }: 1 default: 0 }");
        var property = Assert.IsType<PropertyPatternSyntax>(arm.Value);
        Assert.Equal(2, property.Fields.Count);
        Assert.Equal(SyntaxKind.PropertyPattern, property.Fields[1].Pattern.Kind);
    }

    [Theory]
    [InlineData("[]", 0)]
    [InlineData("[1, _, 3]", 3)]
    public void SwitchExpression_ListPatterns_ParseElementCount(string pattern, int count)
    {
        var arm = ParseFirstSwitchExpressionArm($"let x = switch v {{ case {pattern}: 1 default: 0 }}");
        var list = Assert.IsType<ListPatternSyntax>(arm.Value);
        Assert.Equal(count, list.Elements.Count);
    }

    [Fact]
    public void SwitchStatement_CaseValue_ParsesPattern()
    {
        var tree = SyntaxTree.Parse("switch v { case _ { } }");
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members.OfType<GlobalStatementSyntax>().Select(m => m.Statement).OfType<SwitchStatementSyntax>().Single();
        Assert.Equal(SyntaxKind.DiscardPattern, statement.Cases.Single().Value.Kind);
    }

    // Issue #991: `when` guards parse on switch-expression arms.
    [Fact]
    public void SwitchExpression_WhenGuard_ParsesGuardExpression()
    {
        var arm = ParseFirstSwitchExpressionArm("let x = switch v { case > 0 when v < 10: 1 default: 0 }");
        Assert.Equal(SyntaxKind.RelationalPattern, arm.Value.Kind);
        Assert.NotNull(arm.WhenKeyword);
        Assert.Equal("when", arm.WhenKeyword.Text);
        Assert.NotNull(arm.Guard);
        Assert.Equal(SyntaxKind.BinaryExpression, arm.Guard.Kind);
    }

    [Fact]
    public void SwitchExpression_NoGuard_HasNullGuard()
    {
        var arm = ParseFirstSwitchExpressionArm("let x = switch v { case > 0: 1 default: 0 }");
        Assert.Null(arm.WhenKeyword);
        Assert.Null(arm.Guard);
    }

    // Issue #991: `when` guards parse on switch-statement arms.
    [Fact]
    public void SwitchStatement_WhenGuard_ParsesGuardExpression()
    {
        var tree = SyntaxTree.Parse("switch v { case > 0 when v < 10 { } }");
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members.OfType<GlobalStatementSyntax>().Select(m => m.Statement).OfType<SwitchStatementSyntax>().Single();
        var theCase = statement.Cases.Single();
        Assert.Equal(SyntaxKind.RelationalPattern, theCase.Value.Kind);
        Assert.NotNull(theCase.WhenKeyword);
        Assert.Equal("when", theCase.WhenKeyword.Text);
        Assert.NotNull(theCase.Guard);
        Assert.Equal(SyntaxKind.BinaryExpression, theCase.Guard.Kind);
    }

    private static SwitchExpressionArmSyntax ParseFirstSwitchExpressionArm(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members.OfType<GlobalStatementSyntax>().Select(m => m.Statement).OfType<VariableDeclarationSyntax>().Single();
        var expression = Assert.IsType<SwitchExpressionSyntax>(declaration.Initializer);
        return expression.Arms.First(a => !a.IsDefault);
    }
}
