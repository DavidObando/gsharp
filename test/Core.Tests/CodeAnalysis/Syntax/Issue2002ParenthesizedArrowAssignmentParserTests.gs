// <copyright file="Issue2002ParenthesizedArrowAssignmentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2002 / ADR-0122 §4: an assignment whose LHS is a parenthesized
/// pointer-arrow member access — `(expr)->Member = value` — must parse
/// (no GS0005), for ANY parenthesized receiver shape, not just the bare
/// unparenthesized `p->Member = value` form. The unparenthesized arrow
/// (`p->X = v`) and the explicit dot-desugared form (`(p).X = v`)
/// already worked; only the explicitly-parenthesized arrow-receiver form was
/// broken.
///
/// Root cause: `LooksLikeLambdaStart` (the `(...) ->` lambda vs.
/// pointer-arrow disambiguator) committed to a lambda parse for ANY
/// parenthesized interior whose first token looked like an identifier,
/// without validating the rest of the interior or considering the unsafe
/// context — so `(p)->X = 10` silently mis-parsed as the lambda
/// `(p) -> (X = 10)`, and `(a.b)->X = 10` (an interior that
/// merely *starts* with an identifier but isn't a valid parameter list) hit a
/// genuine GS0005 once the lambda-parameter-list parse choked on the stray
/// `.`.
open class Issue2002ParenthesizedArrowAssignmentParserTests {
    @Theory
    @InlineData("(p)->X = 10")
    @InlineData("(a.b)->X = 10")
    @InlineData("(arr[0])->X = 10")
    @InlineData("(*pp)->X = 10")
    @InlineData("(getPtr())->X = 10")
    func ParenthesizedArrowReceiver_AssignmentTarget_ParsesWithoutGS0005(statement string) {
        let source = (`unsafe func run() {
    ` + "$statement" + `
}`)
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
        Assert.Empty(tree.Diagnostics)
        let assignment MemberFieldAssignmentExpressionSyntax? = Descendants(tree.Root)
            .OfType[MemberFieldAssignmentExpressionSyntax]().SingleOrDefault()
        Assert.NotNull(assignment)
        Assert.Equal(SyntaxKind.RightArrowToken, assignment!!.DotToken.Kind)
        Assert.Equal("X", assignment!!.FieldIdentifier.Text)
    }

    @Fact
    func DoubleIndirection_ParenthesizedDerefArrow_AssignmentTarget_Parses() {
        // The motivating double-indirection shape from the issue:
        // `(*pp)->X = value`, where `pp` is itself a pointer-to-pointer.
        const source = `unsafe func run() {
    (*pp)->X = 77
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let assignment = Descendants(tree.Root).OfType[MemberFieldAssignmentExpressionSyntax]().Single()
        let derefReceiver = Assert.IsType[UnaryExpressionSyntax](assignment.Receiver)
        Assert.Equal(SyntaxKind.StarToken, derefReceiver.OperatorToken.Kind)
        let parenthesized = Assert.IsType[ParenthesizedExpressionSyntax](derefReceiver.Operand)
        let innerDeref = Assert.IsType[UnaryExpressionSyntax](parenthesized.Expression)
        Assert.Equal(SyntaxKind.StarToken, innerDeref.OperatorToken.Kind)
    }

    // ADR-0122 §4: outside an unsafe context, `->` is exclusively the lambda
    // operator (there is no pointer-arrow feature to disambiguate against),
    // so a genuinely malformed lambda parameter list must keep reporting a
    // diagnostic there — this fix is scoped to unsafe contexts only.
    @Fact
    func OutsideUnsafeContext_DottedParenthesizedArrow_StillReportsDiagnostic() {
        const source = `func run() {
    (a.b)->X = 10
}`
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
    }

    // Non-assignment parenthesized-arrow shapes are unaffected by this fix and
    // keep their pre-existing (ADR-documented) lambda interpretation for the
    // maximally-ambiguous bare-single-identifier interior.
    @Fact
    func BareIdentifierParens_NonAssignmentArrowBody_StillParsesAsLambda() {
        const source = `unsafe func run() {
    var f = (p) -> p + 1
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Single(Descendants(tree.Root).OfType[LambdaExpressionSyntax]())
    }

    @Fact
    func MultiParamLambda_StillParsesAsLambda_InUnsafeContext() {
        const source = `unsafe func run() {
    var f = (a, b) -> a + b
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Single(Descendants(tree.Root).OfType[LambdaExpressionSyntax]())
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            for child in node.GetChildren() {
                yield child
                for d in Descendants(child) {
                    yield d
                }
            }
        }
    }
}
