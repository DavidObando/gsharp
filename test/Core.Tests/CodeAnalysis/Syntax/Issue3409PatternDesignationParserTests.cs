// <copyright file="Issue3409PatternDesignationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for ADR-0166 pattern designations (issue #3409).</summary>
public sealed class Issue3409PatternDesignationParserTests
{
    [Fact]
    public void TypeDesignation_ParsesAsTypePatternWithDesignation()
    {
        var expression = ParseIsExpression("if value is string text { }");
        var typePattern = Assert.IsType<TypePatternSyntax>(expression.Pattern);

        Assert.Null(typePattern.Identifier);
        Assert.Null(typePattern.IsKeyword);
        Assert.Equal("string", typePattern.Type.Identifier.Text);
        Assert.Null(typePattern.PropertyPattern);
        Assert.Equal("text", typePattern.Designation?.Text);
        Assert.Equal("text", typePattern.BindingIdentifier?.Text);
    }

    [Fact]
    public void TypeDesignation_IsFollowedByBooleanContinuationAndBody()
    {
        var statement = ParseSingleIf("if value is string text && text.Length > 3 { work() }");
        var and = Assert.IsType<BinaryExpressionSyntax>(statement.Condition);
        var typePattern = Assert.IsType<TypePatternSyntax>(Assert.IsType<IsExpressionSyntax>(and.Left).Pattern);

        Assert.Equal("text", typePattern.Designation?.Text);
        Assert.Single(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void TypePropertyPatternDesignation_AttachesToTypePatternNotSuffix()
    {
        var expression = ParseIsExpression("if value is Dog { Name: \"Rex\" } dog { }");
        var typePattern = Assert.IsType<TypePatternSyntax>(expression.Pattern);

        Assert.Equal("dog", typePattern.Designation?.Text);
        Assert.NotNull(typePattern.PropertyPattern);
        Assert.Null(typePattern.PropertyPattern.Designation);
        Assert.Single(typePattern.PropertyPattern.Fields);
    }

    [Fact]
    public void PropertyPatternDesignation_ParsesBeforeBody()
    {
        var statement = ParseSingleIf("if value is { Length: > 0 } text { work() }");
        var property = Assert.IsType<PropertyPatternSyntax>(Assert.IsType<IsExpressionSyntax>(statement.Condition).Pattern);

        Assert.Equal("text", property.Designation?.Text);
        Assert.Single(property.Fields);
        Assert.Single(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void EmptyPropertyPatternDesignation_ParsesBeforeBody()
    {
        var statement = ParseSingleIf("if value is { } present { work() }");
        var property = Assert.IsType<PropertyPatternSyntax>(Assert.IsType<IsExpressionSyntax>(statement.Condition).Pattern);

        Assert.Equal("present", property.Designation?.Text);
        Assert.Empty(property.Fields);
    }

    [Fact]
    public void NestedDesignations_ParseInsidePropertyPatternFields()
    {
        var expression = ParseIsExpression("if box is { Value: Dog d, Inner: { Size: > 0 } inner } { }");
        var property = Assert.IsType<PropertyPatternSyntax>(expression.Pattern);

        Assert.Null(property.Designation);
        Assert.Equal(2, property.Fields.Count);
        Assert.Equal("d", Assert.IsType<TypePatternSyntax>(property.Fields[0].Pattern).Designation?.Text);
        Assert.Equal("inner", Assert.IsType<PropertyPatternSyntax>(property.Fields[1].Pattern).Designation?.Text);
    }

    [Fact]
    public void Designation_DoesNotSwallowContextualPatternWords()
    {
        var expression = ParseIsExpression("if value is string and not nil { }");
        var binary = Assert.IsType<BinaryPatternSyntax>(expression.Pattern);
        var candidate = Assert.IsType<TypeOrConstantPatternSyntax>(binary.Left);

        Assert.Null(candidate.PropertyPattern);
    }

    [Fact]
    public void Designation_MustSitOnTheSameLineAsThePattern()
    {
        var tree = SyntaxTree.Parse(
            """
            let matched = value is string
            work()
            """);

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var expression = Assert.IsType<IsExpressionSyntax>(declaration.Initializer);
        Assert.IsType<TypeOrConstantPatternSyntax>(expression.Pattern);
    }

    [Fact]
    public void ExistingBodyDisambiguation_IsUnchanged()
    {
        var statement = ParseSingleIf("if value is string { }");
        var candidate = Assert.IsType<TypeOrConstantPatternSyntax>(Assert.IsType<IsExpressionSyntax>(statement.Condition).Pattern);

        Assert.Null(candidate.PropertyPattern);
        Assert.Empty(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void SwitchCases_AcceptTypeDesignationSpelling()
    {
        var tree = SyntaxTree.Parse(
            """
            switch shape {
                case Circle c { work(c) }
                case Square { Side: > 0 } sq when sq.Side > 1 { work(sq) }
                case d is Dog { work(d) }
                default { }
            }
            let area = switch shape {
                case Circle c: c.Radius
                default: 0
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var switchStatement = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<SwitchStatementSyntax>()
            .Single();
        var patterns = switchStatement.Cases
            .Where(caseSyntax => caseSyntax.Value != null)
            .Select(caseSyntax => Assert.IsType<TypePatternSyntax>(caseSyntax.Value))
            .ToArray();

        Assert.Equal(["c", "sq", "d"], patterns.Select(pattern => pattern.BindingIdentifier?.Text));
        Assert.Equal([null, null, "d"], patterns.Select(pattern => pattern.Identifier?.Text));
        Assert.NotNull(patterns[1].PropertyPattern);
        Assert.NotNull(switchStatement.Cases[1].Guard);
    }

    [Fact]
    public void Ternary_ParsesDesignationBeforeQuestion()
    {
        var tree = SyntaxTree.Parse("let label = value is int32 n ? n : 0");

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var conditional = Assert.IsType<ConditionalExpressionSyntax>(declaration.Initializer);
        var typePattern = Assert.IsType<TypePatternSyntax>(Assert.IsType<IsExpressionSyntax>(conditional.Condition).Pattern);
        Assert.Equal("n", typePattern.Designation?.Text);
    }

    private static IsExpressionSyntax ParseIsExpression(string source)
    {
        var condition = ParseSingleIf(source).Condition;
        while (condition is ParenthesizedExpressionSyntax parenthesized)
        {
            condition = parenthesized.Expression;
        }

        return Assert.IsType<IsExpressionSyntax>(condition);
    }

    private static IfStatementSyntax ParseSingleIf(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        return tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<IfStatementSyntax>()
            .Single();
    }
}
