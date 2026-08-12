// <copyright file="Issue3351IsPatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for boolean pattern <c>is</c> expressions (issue #3351).</summary>
public sealed class Issue3351IsPatternParserTests
{
    [Theory]
    [InlineData("\"a\" or \"b\"", SyntaxKind.BinaryPattern)]
    [InlineData("> 0 and < 10", SyntaxKind.BinaryPattern)]
    [InlineData("[1, ..]", SyntaxKind.ListPattern)]
    [InlineData("not 0", SyntaxKind.NotPattern)]
    [InlineData("(0 or 1)", SyntaxKind.ParenthesizedPattern)]
    [InlineData("nil", SyntaxKind.ConstantPattern)]
    public void IsExpression_ParsesFullPatternGrammar(string pattern, SyntaxKind expectedKind)
    {
        var expression = ParseIsExpression($"if value is {pattern} {{ }}");

        Assert.Equal(expectedKind, expression.Pattern.Kind);
    }

    [Fact]
    public void BareName_PreservesBothTypeAndValueSyntaxInterpretations()
    {
        var expression = ParseIsExpression("if value is string { }");
        var candidate = Assert.IsType<TypeOrConstantPatternSyntax>(expression.Pattern);

        Assert.Equal("string", Assert.IsType<NameExpressionSyntax>(candidate.Expression).IdentifierToken.Text);
        Assert.Equal("string", candidate.CandidateType.Identifier.Text);
        Assert.Null(candidate.PropertyPattern);
    }

    [Fact]
    public void PropertyPatternBeforeBody_CommitsFirstBraceToPattern()
    {
        var statement = ParseSingleIf("if value is { Length: > 0 } { work() }");
        var expression = Assert.IsType<IsExpressionSyntax>(statement.Condition);

        Assert.IsType<PropertyPatternSyntax>(expression.Pattern);
        Assert.Single(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void TypePropertyPatternBeforeBody_ComposesOnTypeCandidate()
    {
        var expression = ParseIsExpression("if value is string { Length: > 0 } { }");
        var typePattern = Assert.IsType<TypePatternSyntax>(expression.Pattern);

        Assert.Null(typePattern.Identifier);
        Assert.NotNull(typePattern.PropertyPattern);
        Assert.Single(typePattern.PropertyPattern.Fields);
    }

    [Fact]
    public void ExistingTypeTestWithEmptyBody_DoesNotConsumeBodyAsPropertyPattern()
    {
        var statement = ParseSingleIf("if value is string { }");
        var expression = Assert.IsType<IsExpressionSyntax>(statement.Condition);
        var candidate = Assert.IsType<TypeOrConstantPatternSyntax>(expression.Pattern);

        Assert.Null(candidate.PropertyPattern);
        Assert.Empty(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void BareTypeSwitchCase_DoesNotConsumeCaseBodyAsPropertySuffix()
    {
        var tree = SyntaxTree.Parse("switch value { case string { work() } default { } }");
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<SwitchStatementSyntax>()
            .Single();
        var candidate = Assert.IsType<TypeOrConstantPatternSyntax>(statement.Cases[0].Value);

        Assert.Null(candidate.PropertyPattern);
        Assert.Single(statement.Cases[0].Body.Statements);
    }

    [Fact]
    public void ExistingNameLedSwitchExpressionPattern_RemainsValueExpression()
    {
        var tree = SyntaxTree.Parse(
            "let result = switch value { case limit + 1: true default: false }");
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var expression = Assert.IsType<SwitchExpressionSyntax>(declaration.Initializer);
        var constant = Assert.IsType<ConstantPatternSyntax>(expression.Arms[0].Value);

        Assert.IsType<BinaryExpressionSyntax>(constant.Expression);
    }

    [Fact]
    public void LoneEmptyBrace_RemainsIfBodyAndReportsMissingPattern()
    {
        var tree = SyntaxTree.Parse("if value is { }");
        var diagnostic = Assert.Single(tree.Diagnostics);
        var statement = GetIfStatements(tree).Single();
        var expression = Assert.IsType<IsExpressionSyntax>(statement.Condition);

        Assert.Equal("GS0005", diagnostic.Id);
        Assert.Equal("{", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.IsType<ConstantPatternSyntax>(expression.Pattern);
        Assert.Empty(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void ParenthesizedEmptyPropertyPattern_IsUnambiguousEscapeHatch()
    {
        var expression = ParseIsExpression("if (value is { }) { }");
        Assert.IsType<PropertyPatternSyntax>(expression.Pattern);
    }

    [Fact]
    public void EmptyPropertyPattern_CommitsWhenSeparateBodyBraceFollows()
    {
        var statement = ParseSingleIf("if value is { } { work() }");
        var expression = Assert.IsType<IsExpressionSyntax>(statement.Condition);

        Assert.Empty(Assert.IsType<PropertyPatternSyntax>(expression.Pattern).Fields);
        Assert.Single(Assert.IsType<BlockStatementSyntax>(statement.ThenStatement).Statements);
    }

    [Fact]
    public void MalformedPropertyPattern_CommitsWhenBodyFollowsAndKeepsDiagnosticSpan()
    {
        var tree = SyntaxTree.Parse("if value is { Length > 0 } { }");
        var diagnostic = Assert.Single(tree.Diagnostics);
        var expression = Assert.IsType<IsExpressionSyntax>(GetIfStatements(tree).Single().Condition);

        Assert.Equal("GS0005", diagnostic.Id);
        Assert.Equal(">", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.IsType<PropertyPatternSyntax>(expression.Pattern);
    }

    [Fact]
    public void StructAndObjectLiteralsNearby_DoNotStealPatternOrBodyBraces()
    {
        const string Source = """
            let point = Point{X = 1}
            if point is { X: 1 } { }
            let anonymous = object { let P int32 = 1 }
            if anonymous is { P: 1 } { }
            """;

        var tree = SyntaxTree.Parse(Source);

        Assert.Empty(tree.Diagnostics);
        Assert.Equal(2, GetIfStatements(tree).Count());
        Assert.All(
            GetIfStatements(tree),
            statement => Assert.IsType<PropertyPatternSyntax>(
                Assert.IsType<IsExpressionSyntax>(statement.Condition).Pattern));
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
        return GetIfStatements(tree).Single();
    }

    private static System.Collections.Generic.IEnumerable<IfStatementSyntax> GetIfStatements(SyntaxTree tree)
        => tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<IfStatementSyntax>();
}
