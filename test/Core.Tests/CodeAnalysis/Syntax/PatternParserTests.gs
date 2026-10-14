// <copyright file="PatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser coverage for Phase 6.2 switch patterns.
open class PatternParserTests {
    @Theory
    @InlineData("1", SyntaxKind(189))
    @InlineData("_", SyntaxKind(191))
    @InlineData("v is Foo", SyntaxKind(193))
    @InlineData("{ Name: \"x\" }", SyntaxKind(194))
    @InlineData("[1, _, 3]", SyntaxKind(197))
    func SwitchExpression_CaseValue_ParsesPattern(pattern string, expectedKind SyntaxKind) {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case $pattern: 1 default: 0 }")
        Assert.Equal(expectedKind, arm.Value!!.Kind)
    }

    @Theory
    @InlineData("< 0")
    @InlineData("<= 0")
    @InlineData("> 0")
    @InlineData(">= 0")
    @InlineData("== 0")
    @InlineData("!= 0")
    func SwitchExpression_RelationalPatterns_Parse(pattern string) {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case $pattern: 1 default: 0 }")
        Assert.Equal(SyntaxKind.RelationalPattern, arm.Value!!.Kind)
    }

    @Fact
    func SwitchExpression_PropertyPattern_ParsesMultipleAndNestedFields() {
        let arm = ParseFirstSwitchExpressionArm(
            "let x = switch v { case { Name: \"x\", Child: { Name: \"y\" } }: 1 default: 0 }"
        )
        let property = Assert.IsType[PropertyPatternSyntax](arm.Value)
        Assert.Equal(2, property.Fields.Count)
        Assert.Equal(SyntaxKind.PropertyPattern, property.Fields[1].Pattern.Kind)
    }

    @Theory
    @InlineData("[]", int32(0))
    @InlineData("[1, _, 3]", int32(3))
    func SwitchExpression_ListPatterns_ParseElementCount(pattern string, count int32) {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case $pattern: 1 default: 0 }")
        let list = Assert.IsType[ListPatternSyntax](arm.Value)
        Assert.Equal(count, list.Elements.Count)
    }

    @Fact
    func SwitchStatement_CaseValue_ParsesPattern() {
        let tree = SyntaxTree.Parse("switch v { case _ { } }")
        Assert.Empty(tree.Diagnostics)
        let statement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((m GlobalStatementSyntax) -> m.Statement)
            .OfType[SwitchStatementSyntax]()
            .Single()
        Assert.Equal(SyntaxKind.DiscardPattern, statement.Cases.Single().Value!!.Kind)
    }

    // Issue #991: `when` guards parse on switch-expression arms.
    @Fact
    func SwitchExpression_WhenGuard_ParsesGuardExpression() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case > 0 when v < 10: 1 default: 0 }")
        Assert.Equal(SyntaxKind.RelationalPattern, arm.Value!!.Kind)
        Assert.NotNull(arm.WhenKeyword)
        Assert.Equal("when", arm.WhenKeyword!!.Text)
        Assert.NotNull(arm.Guard)
        Assert.Equal(SyntaxKind.BinaryExpression, arm.Guard!!.Kind)
    }

    @Fact
    func SwitchExpression_NoGuard_HasNullGuard() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case > 0: 1 default: 0 }")
        Assert.Null(arm.WhenKeyword)
        Assert.Null(arm.Guard)
    }

    // Issue #991: `when` guards parse on switch-statement arms.
    @Fact
    func SwitchStatement_WhenGuard_ParsesGuardExpression() {
        let tree = SyntaxTree.Parse("switch v { case > 0 when v < 10 { } }")
        Assert.Empty(tree.Diagnostics)
        let statement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((m GlobalStatementSyntax) -> m.Statement)
            .OfType[SwitchStatementSyntax]()
            .Single()
        let theCase = statement.Cases.Single()
        Assert.Equal(SyntaxKind.RelationalPattern, theCase.Value!!.Kind)
        Assert.NotNull(theCase.WhenKeyword)
        Assert.Equal("when", theCase.WhenKeyword!!.Text)
        Assert.NotNull(theCase.Guard)
        Assert.Equal(SyntaxKind.BinaryExpression, theCase.Guard!!.Kind)
    }

    @Fact
    func SwitchStatement_WhenCallGuard_DoesNotConsumeCaseBodyAsInitializer() {
        let tree = SyntaxTree.Parse("switch v { case > 0 when object.ReferenceEquals(v, other) { } case _ { } }")
        Assert.Empty(tree.Diagnostics)
        let statement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[SwitchStatementSyntax]()
            .Single()
        Assert.Equal(2, statement.Cases.Length)
        Assert.Equal(SyntaxKind.AccessorExpression, statement.Cases[0].Guard!!.Kind)
    }

    @Theory
    @InlineData("[..]", int32(1), int32(0))
    @InlineData("[1, .., 3]", int32(3), int32(1))
    @InlineData("[.., last]", int32(2), int32(0))
    @InlineData("[first, ..]", int32(2), int32(1))
    func SwitchExpression_SlicePattern_ParsesAsSliceElement(pattern string, count int32, sliceIndex int32) {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case $pattern: 1 default: 0 }")
        let list = Assert.IsType[ListPatternSyntax](arm.Value)
        Assert.Equal(count, list.Elements.Count)
        let slice = Assert.IsType[SlicePatternSyntax](list.Elements[sliceIndex])
        Assert.Equal(SyntaxKind.SlicePattern, slice.Kind)
        Assert.Null(slice.CaptureIdentifier)
        Assert.Null(slice.Pattern)
    }

    @Fact
    func SwitchExpression_CapturedSlicePattern_ParsesCaptureIdentifier() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case [first, ..rest, last]: 1 default: 0 }")
        let list = Assert.IsType[ListPatternSyntax](arm.Value)
        Assert.Equal(3, list.Elements.Count)
        let slice = Assert.IsType[SlicePatternSyntax](list.Elements[1])
        Assert.NotNull(slice.CaptureIdentifier)
        Assert.Equal("rest", slice.CaptureIdentifier!!.Text)
        Assert.Null(slice.Pattern)
    }

    @Fact
    func SwitchExpression_SlicePattern_IsNotParsedAsRangeExpression() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case [1, .., 3]: 1 default: 0 }")
        let list = Assert.IsType[ListPatternSyntax](arm.Value)
        // The middle element must be a slice subpattern, never a range/constant expression pattern.
        Assert.IsType[SlicePatternSyntax](list.Elements[1])
        Assert.IsType[ConstantPatternSyntax](list.Elements[0])
        Assert.IsType[ConstantPatternSyntax](list.Elements[2])
    }

    @Fact
    func SwitchExpression_MultipleSlicePatterns_ParseWithoutSyntaxError() {
        // Multiple slices are a binder-level diagnostic (GS0416), not a syntax error.
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case [1, .., .., 3]: 1 default: 0 }")
        let list = Assert.IsType[ListPatternSyntax](arm.Value)
        Assert.Equal(4, list.Elements.Count)
        Assert.IsType[SlicePatternSyntax](list.Elements[1])
        Assert.IsType[SlicePatternSyntax](list.Elements[2])
    }

    // Issue #992: `and` / `or` / `not` pattern combinators and parentheses.
    @Fact
    func SwitchExpression_AndPattern_ParsesAsBinaryPattern() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case > 0 and < 10: 1 default: 0 }")
        let binary = Assert.IsType[BinaryPatternSyntax](arm.Value)
        Assert.Equal("and", binary.OperatorToken.Text)
        Assert.Equal(SyntaxKind.RelationalPattern, binary.Left.Kind)
        Assert.Equal(SyntaxKind.RelationalPattern, binary.Right.Kind)
    }

    @Fact
    func SwitchExpression_OrPattern_ParsesAsBinaryPattern() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case < 0 or > 100: 1 default: 0 }")
        let binary = Assert.IsType[BinaryPatternSyntax](arm.Value)
        Assert.Equal("or", binary.OperatorToken.Text)
    }

    @Fact
    func SwitchExpression_NotPattern_ParsesAsNotPattern() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case not > 0: 1 default: 0 }")
        let not = Assert.IsType[NotPatternSyntax](arm.Value)
        Assert.Equal("not", not.NotKeyword.Text)
        Assert.Equal(SyntaxKind.RelationalPattern, not.Pattern.Kind)
    }

    // Precedence: `not` binds tightest, then `and`, then `or`. So
    // `a or b and c` parses as `a or (b and c)`.
    @Fact
    func SwitchExpression_Precedence_AndBindsTighterThanOr() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case == 0 or > 5 and < 10: 1 default: 0 }")
        let or = Assert.IsType[BinaryPatternSyntax](arm.Value)
        Assert.Equal("or", or.OperatorToken.Text)
        Assert.Equal(SyntaxKind.RelationalPattern, or.Left.Kind)
        let and = Assert.IsType[BinaryPatternSyntax](or.Right)
        Assert.Equal("and", and.OperatorToken.Text)
    }

    // `not a and b` parses as `(not a) and b`.
    @Fact
    func SwitchExpression_Precedence_NotBindsTighterThanAnd() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case not > 0 and < 10: 1 default: 0 }")
        let and = Assert.IsType[BinaryPatternSyntax](arm.Value)
        Assert.Equal("and", and.OperatorToken.Text)
        Assert.Equal(SyntaxKind.NotPattern, and.Left.Kind)
        Assert.Equal(SyntaxKind.RelationalPattern, and.Right.Kind)
    }

    @Fact
    func SwitchExpression_ParenthesizedPattern_OverridesPrecedence() {
        let arm = ParseFirstSwitchExpressionArm("let x = switch v { case (== 0 or == 1) and < 10: 1 default: 0 }")
        let and = Assert.IsType[BinaryPatternSyntax](arm.Value)
        Assert.Equal("and", and.OperatorToken.Text)
        let paren = Assert.IsType[ParenthesizedPatternSyntax](and.Left)
        let or = Assert.IsType[BinaryPatternSyntax](paren.Pattern)
        Assert.Equal("or", or.OperatorToken.Text)
    }

    shared {
        private func ParseFirstSwitchExpressionArm(source string) SwitchExpressionArmSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let declaration = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((m GlobalStatementSyntax) -> m.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            let expression = Assert.IsType[SwitchExpressionSyntax](declaration.Initializer)
            return expression.Arms.First((a SwitchExpressionArmSyntax) -> !a.IsDefault)
        }
    }
}
