// <copyright file="Issue714LambdaParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #714 / ADR-0074 — parser-level tests for the new arrow-lambda
/// expression form (`(x int32) -> body`) and for the switch-arm
/// separator change (preferred `:`, deprecated `->` still
/// accepted with a warning).
open class Issue714LambdaParserTests {
    @Fact
    func Parses_LambdaExpression_InLetInitializer_SingleExpressionBody() {
        const source = "package P\nlet f = (x int32) -> x + 1"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
        Assert.Equal("x", lambda.Parameters[0].Identifier!!.Text)
        Assert.Equal(SyntaxKind.RightArrowToken, lambda.ArrowToken.Kind)
        Assert.IsType[BinaryExpressionSyntax](lambda.Body)
    }

    @Fact
    func Parses_LambdaExpression_WithBlockBody() {
        const source = `package P
let f = (x int32) -> {
  let y = x * 2
  y + 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
        Assert.IsType[BlockExpressionSyntax](lambda.Body)
    }

    @Fact
    func Parses_LambdaExpression_NoParameters() {
        const source = "package P\nlet f = () -> 42"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Empty(lambda.Parameters)
        Assert.IsType[LiteralExpressionSyntax](lambda.Body)
    }

    @Fact
    func Parses_LambdaExpression_MultipleParameters() {
        const source = "package P\nlet f = (x int32, y int32) -> x + y"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Equal(2, lambda.Parameters.Count)
        Assert.Equal("x", lambda.Parameters[0].Identifier!!.Text)
        Assert.Equal("y", lambda.Parameters[1].Identifier!!.Text)
    }

    @Fact
    func Parses_LambdaExpression_InArgumentPosition() {
        // Lambdas as call arguments — exercise parser disambiguation
        // inside an argument list.
        const source = `package P
func apply(f Func[int32, int32]) int32 { return f(3) }
let v = apply((x int32) -> x + 1)`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
    }

    @Fact
    func Parses_BareIdentifierArrow_AsSingleParameterLambda() {
        // Issue #932: the single-identifier arrow shorthand `x -> e` is now
        // accepted as exact sugar for `(x) -> e` (one untyped parameter). This
        // revises the original ADR-0074 decision (which rejected the
        // shorthand); see ADR-0074 alternative C. `->` is never an
        // expression-level binary operator, so committing `IDENT ->` to a
        // lambda is unambiguous.
        const source = `package P
func apply(f Func[int32, int32]) int32 { return f(3) }
let v = apply(x -> x + 1)`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
        Assert.Null(lambda.OpenParenToken)
        Assert.Null(lambda.CloseParenToken)
    }

    @Fact
    func Parses_ParenthesizedExpression_NotMistakenForLambda() {
        // `(1 + 2) * 3` must remain a parenthesised expression, not a lambda.
        const source = "package P\nlet v = (1 + 2) * 3"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.False(Walk(tree.Root).OfType[LambdaExpressionSyntax]().Any())
    }

    @Fact
    func Parses_SwitchExpressionArm_ColonForm_ProducesNoWarning() {
        const source = `package P
let v = switch 1 {
  case 0: "zero"
  default: "other"
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let arms = Walk(tree.Root).OfType[SwitchExpressionArmSyntax]().ToList()
        Assert.Equal(2, arms.Count)
        Assert.All(arms, (a SwitchExpressionArmSyntax) -> Assert.Equal(SyntaxKind.ColonToken, a.ArrowToken.Kind))
    }

    @Fact
    func Parses_SwitchExpressionArm_ArrowForm_StillAcceptedAndWarns() {
        const source = `package P
let v = switch 1 {
  case 0 -> "zero"
  default -> "other"
}`
        let tree = SyntaxTree.Parse(source)
        let arms = Walk(tree.Root).OfType[SwitchExpressionArmSyntax]().ToList()
        Assert.Equal(2, arms.Count)
        Assert.All(arms, (a SwitchExpressionArmSyntax) -> Assert.Equal(SyntaxKind.RightArrowToken, a.ArrowToken.Kind))
        let warnings = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0302").ToList()
        Assert.Equal(2, warnings.Count)
        Assert.All(warnings, (w Diagnostic) -> Assert.False(w.IsError))
    }

    @Fact
    func Parses_SwitchExpressionArm_MixedSeparators_OnlyArrowsWarn() {
        const source = `package P
let v = switch 1 {
  case 0: "zero"
  case 1 -> "one"
  default: "other"
}`
        let tree = SyntaxTree.Parse(source)
        let arms = Walk(tree.Root).OfType[SwitchExpressionArmSyntax]().ToList()
        Assert.Equal(3, arms.Count)
        Assert.Equal(SyntaxKind.ColonToken, arms[0].ArrowToken.Kind)
        Assert.Equal(SyntaxKind.RightArrowToken, arms[1].ArrowToken.Kind)
        Assert.Equal(SyntaxKind.ColonToken, arms[2].ArrowToken.Kind)
        let warnings = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0302").ToList()
        Assert.Single(warnings)
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                if c is SyntaxNode sn {
                    for d in Walk(sn) {
                        yield d
                    }
                }
            }
        }
    }
}
