// <copyright file="Issue3351IsPatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Parser coverage for boolean pattern `is` expressions (issue #3351).
class Issue3351IsPatternParserTests {
    @Theory
    @InlineData("\"a\" or \"b\"", SyntaxKind(199))
    @InlineData("> 0 and < 10", SyntaxKind(199))
    @InlineData("[1, ..]", SyntaxKind(197))
    @InlineData("not 0", SyntaxKind(200))
    @InlineData("(0 or 1)", SyntaxKind(201))
    @InlineData("nil", SyntaxKind(189))
    func IsExpression_ParsesFullPatternGrammar(pattern string, expectedKind SyntaxKind) {
        let expression = ParseIsExpression("if value is $pattern { }")
        Assert.Equal(expectedKind, expression.Pattern.Kind)
    }

    @Fact
    func BareName_PreservesBothTypeAndValueSyntaxInterpretations() {
        let expression = ParseIsExpression("if value is string { }")
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](expression.Pattern)
        Assert.Equal("string", Assert.IsType[NameExpressionSyntax](candidate.Expression).IdentifierToken.Text)
        Assert.Equal("string", candidate.CandidateType.Identifier!!.Text)
        Assert.Null(candidate.PropertyPattern)
    }

    @Fact
    func PropertyPatternBeforeBody_CommitsFirstBraceToPattern() {
        let statement = ParseSingleIf("if value is { Length: > 0 } { work() }")
        let expression = Assert.IsType[IsExpressionSyntax](statement.Condition)
        Assert.IsType[PropertyPatternSyntax](expression.Pattern)
        Assert.Single(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func TypePropertyPatternBeforeBody_ComposesOnTypeCandidate() {
        let expression = ParseIsExpression("if value is string { Length: > 0 } { }")
        let typePattern = Assert.IsType[TypePatternSyntax](expression.Pattern)
        Assert.Null(typePattern.Identifier)
        Assert.NotNull(typePattern.PropertyPattern)
        Assert.Single(typePattern.PropertyPattern!!.Fields)
    }

    @Fact
    func ExistingTypeTestWithEmptyBody_DoesNotConsumeBodyAsPropertyPattern() {
        let statement = ParseSingleIf("if value is string { }")
        let expression = Assert.IsType[IsExpressionSyntax](statement.Condition)
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](expression.Pattern)
        Assert.Null(candidate.PropertyPattern)
        Assert.Empty(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func IfExpression_TypeTest_DoesNotConsumeCallValuedBranchAsPropertyPattern() {
        let tree = SyntaxTree.Parse("let result = if value is string { Make(nil, value) } else { value }")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let expression = Assert.IsType[IfExpressionSyntax](declaration.Initializer)
        let typeTest = Assert.IsType[IsExpressionSyntax](expression.Condition)
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](typeTest.Pattern)
        Assert.Null(candidate.PropertyPattern)
        Assert.IsType[CallExpressionSyntax](expression.ThenBlock.Expression)
    }

    @Fact
    func BareTypeSwitchCase_DoesNotConsumeCaseBodyAsPropertySuffix() {
        let tree = SyntaxTree.Parse("switch value { case string { work() } default { } }")
        Assert.Empty(tree.Diagnostics)
        let statement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[SwitchStatementSyntax]()
            .Single()
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](statement.Cases[0].Value)
        Assert.Null(candidate.PropertyPattern)
        Assert.Single(statement.Cases[0].Body.Statements)
    }

    @Fact
    func ExistingNameLedSwitchExpressionPattern_RemainsValueExpression() {
        let tree = SyntaxTree.Parse("let result = switch value { case limit + 1: true default: false }")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let expression = Assert.IsType[SwitchExpressionSyntax](declaration.Initializer)
        let constant = Assert.IsType[ConstantPatternSyntax](expression.Arms[0].Value)
        Assert.IsType[BinaryExpressionSyntax](constant.Expression)
    }

    @Fact
    func LoneEmptyBrace_RemainsIfBodyAndReportsMissingPattern() {
        let tree = SyntaxTree.Parse("if value is { }")
        let diagnostic = Assert.Single(tree.Diagnostics)
        let statement = GetIfStatements(tree).Single()
        let expression = Assert.IsType[IsExpressionSyntax](statement.Condition)
        Assert.Equal("GS0005", diagnostic.Id)
        Assert.Equal("{", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.IsType[ConstantPatternSyntax](expression.Pattern)
        Assert.Empty(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func ParenthesizedEmptyPropertyPattern_IsUnambiguousEscapeHatch() {
        let expression = ParseIsExpression("if (value is { }) { }")
        Assert.IsType[PropertyPatternSyntax](expression.Pattern)
    }

    @Fact
    func EmptyPropertyPattern_CommitsWhenSeparateBodyBraceFollows() {
        let statement = ParseSingleIf("if value is { } { work() }")
        let expression = Assert.IsType[IsExpressionSyntax](statement.Condition)
        Assert.Empty(Assert.IsType[PropertyPatternSyntax](expression.Pattern).Fields)
        Assert.Single(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func MalformedPropertyPattern_CommitsWhenBodyFollowsAndKeepsDiagnosticSpan() {
        let tree = SyntaxTree.Parse("if value is { Length > 0 } { }")
        let diagnostic = Assert.Single(tree.Diagnostics)
        let expression = Assert.IsType[IsExpressionSyntax](GetIfStatements(tree).Single().Condition)
        Assert.Equal("GS0005", diagnostic.Id)
        Assert.Equal(">", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.IsType[PropertyPatternSyntax](expression.Pattern)
    }

    @Fact
    func StructAndObjectLiteralsNearby_DoNotStealPatternOrBodyBraces() {
        const Source = `let point = Point{X = 1}
if point is { X: 1 } { }
let anonymous = object { let P int32 = 1 }
if anonymous is { P: 1 } { }`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(2, GetIfStatements(tree).Count())
        Assert.All(
            GetIfStatements(tree),
            (statement IfStatementSyntax) -> Assert.IsType[PropertyPatternSyntax](
                Assert.IsType[IsExpressionSyntax](statement.Condition).Pattern
            )
        )
    }

    shared {
        private func ParseIsExpression(source string) IsExpressionSyntax {
            var condition = ParseSingleIf(source).Condition
            while condition is ParenthesizedExpressionSyntax parenthesized {
                condition = parenthesized.Expression
            }
            return Assert.IsType[IsExpressionSyntax](condition)
        }

        private func ParseSingleIf(source string) IfStatementSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            return GetIfStatements(tree).Single()
        }

        private func GetIfStatements(tree SyntaxTree) IEnumerable[IfStatementSyntax] -> tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[IfStatementSyntax]()
    }
}
