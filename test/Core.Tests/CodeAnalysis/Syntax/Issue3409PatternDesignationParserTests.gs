// <copyright file="Issue3409PatternDesignationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser coverage for ADR-0166 pattern designations (issue #3409).
class Issue3409PatternDesignationParserTests {
    @Fact
    func TypeDesignation_ParsesAsTypePatternWithDesignation() {
        let expression = ParseIsExpression("if value is string text { }")
        let typePattern = Assert.IsType[TypePatternSyntax](expression.Pattern)
        Assert.Null(typePattern.Identifier)
        Assert.Null(typePattern.IsKeyword)
        Assert.Equal("string", typePattern.Type.Identifier!!.Text)
        Assert.Null(typePattern.PropertyPattern)
        Assert.Equal("text", typePattern.Designation?.Text)
        Assert.Equal("text", typePattern.BindingIdentifier?.Text)
    }

    @Fact
    func TypeDesignation_IsFollowedByBooleanContinuationAndBody() {
        let statement = ParseSingleIf("if value is string text && text.Length > 3 { work() }")
        let and = Assert.IsType[BinaryExpressionSyntax](statement.Condition)
        let typePattern = Assert.IsType[TypePatternSyntax](Assert.IsType[IsExpressionSyntax](and.Left).Pattern)
        Assert.Equal("text", typePattern.Designation?.Text)
        Assert.Single(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func TypePropertyPatternDesignation_AttachesToTypePatternNotSuffix() {
        let expression = ParseIsExpression("if value is Dog { Name: \"Rex\" } dog { }")
        let typePattern = Assert.IsType[TypePatternSyntax](expression.Pattern)
        Assert.Equal("dog", typePattern.Designation?.Text)
        Assert.NotNull(typePattern.PropertyPattern)
        Assert.Null(typePattern.PropertyPattern!!.Designation)
        Assert.Single(typePattern.PropertyPattern!!.Fields)
    }

    @Fact
    func PropertyPatternDesignation_ParsesBeforeBody() {
        let statement = ParseSingleIf("if value is { Length: > 0 } text { work() }")
        let property = Assert.IsType[PropertyPatternSyntax](
            Assert.IsType[IsExpressionSyntax](statement.Condition).Pattern
        )
        Assert.Equal("text", property.Designation?.Text)
        Assert.Equal("text", property.BindingIdentifier?.Text)
        Assert.Single(property.Fields)
        Assert.Single(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func EmptyPropertyPatternDesignation_ParsesBeforeBody() {
        let statement = ParseSingleIf("if value is { } present { work() }")
        let property = Assert.IsType[PropertyPatternSyntax](
            Assert.IsType[IsExpressionSyntax](statement.Condition).Pattern
        )
        Assert.Equal("present", property.Designation?.Text)
        Assert.Empty(property.Fields)
    }

    @Fact
    func NestedDesignations_ParseInsidePropertyPatternFields() {
        let expression = ParseIsExpression("if box is { Value: Dog d, Inner: { Size: > 0 } inner } { }")
        let property = Assert.IsType[PropertyPatternSyntax](expression.Pattern)
        Assert.Null(property.Designation)
        Assert.Equal(2, property.Fields.Count)
        Assert.Equal("d", Assert.IsType[TypePatternSyntax](property.Fields[0].Pattern).Designation?.Text)
        Assert.Equal("inner", Assert.IsType[PropertyPatternSyntax](property.Fields[1].Pattern).Designation?.Text)
    }

    @Fact
    func Designation_DoesNotSwallowContextualPatternWords() {
        let expression = ParseIsExpression("if value is string and not nil { }")
        let binary = Assert.IsType[BinaryPatternSyntax](expression.Pattern)
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](binary.Left)
        Assert.Null(candidate.PropertyPattern)
    }

    @Fact
    func Designation_MustSitOnTheSameLineAsThePattern() {
        let tree = SyntaxTree.Parse("let matched = value is string\nwork()")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let expression = Assert.IsType[IsExpressionSyntax](declaration.Initializer)
        Assert.IsType[TypeOrConstantPatternSyntax](expression.Pattern)
    }

    @Fact
    func ExistingBodyDisambiguation_IsUnchanged() {
        let statement = ParseSingleIf("if value is string { }")
        let candidate = Assert.IsType[TypeOrConstantPatternSyntax](
            Assert.IsType[IsExpressionSyntax](statement.Condition).Pattern
        )
        Assert.Null(candidate.PropertyPattern)
        Assert.Empty(Assert.IsType[BlockStatementSyntax](statement.ThenStatement).Statements)
    }

    @Fact
    func SwitchCases_AcceptTypeDesignationSpelling() {
        let tree = SyntaxTree.Parse(`switch shape {
    case Circle c { work(c) }
    case Square { Side: > 0 } sq when sq.Side > 1 { work(sq) }
    case d is Dog { work(d) }
    default { }
}
let area = switch shape {
    case Circle c: c.Radius
    default: 0
}`)
        Assert.Empty(tree.Diagnostics)
        let switchStatement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[SwitchStatementSyntax]()
            .Single()
        let patterns = switchStatement
            .Cases
            .Where((caseSyntax SwitchCaseSyntax) -> caseSyntax.Value != nil)
            .Select((caseSyntax SwitchCaseSyntax) -> Assert.IsType[TypePatternSyntax](caseSyntax.Value))
            .ToArray()
        Assert.Equal(
            []string{"c", "sq", "d"},
            patterns.Select((pattern TypePatternSyntax) -> pattern.BindingIdentifier?.Text)
        )
        Assert.Equal(
            []string? {nil, nil, "d"},
            patterns.Select((pattern TypePatternSyntax) -> pattern.Identifier?.Text)
        )
        Assert.NotNull(patterns[1].PropertyPattern)
        Assert.NotNull(switchStatement.Cases[1].Guard)
    }

    @Fact
    func Ternary_ParsesDesignationBeforeQuestion() {
        let tree = SyntaxTree.Parse("let label = value is int32 n ? n : 0")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let conditional = Assert.IsType[ConditionalExpressionSyntax](declaration.Initializer)
        let typePattern = Assert.IsType[TypePatternSyntax](
            Assert.IsType[IsExpressionSyntax](conditional.Condition).Pattern
        )
        Assert.Equal("n", typePattern.Designation?.Text)
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
            return tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((member GlobalStatementSyntax) -> member.Statement)
                .OfType[IfStatementSyntax]()
                .Single()
        }
    }
}
