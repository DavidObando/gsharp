// <copyright file="Issue2002ParenthesizedArrowAssignmentParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #2002 / ADR-0122 §4: an assignment whose LHS is a parenthesized
/// pointer-arrow member access — <c>(expr)-&gt;Member = value</c> — must parse
/// (no GS0005), for ANY parenthesized receiver shape, not just the bare
/// unparenthesized <c>p-&gt;Member = value</c> form. The unparenthesized arrow
/// (<c>p-&gt;X = v</c>) and the explicit dot-desugared form (<c>(p).X = v</c>)
/// already worked; only the explicitly-parenthesized arrow-receiver form was
/// broken.
/// <para>
/// Root cause: <c>LooksLikeLambdaStart</c> (the <c>(...) -&gt;</c> lambda vs.
/// pointer-arrow disambiguator) committed to a lambda parse for ANY
/// parenthesized interior whose first token looked like an identifier,
/// without validating the rest of the interior or considering the unsafe
/// context — so <c>(p)-&gt;X = 10</c> silently mis-parsed as the lambda
/// <c>(p) -&gt; (X = 10)</c>, and <c>(a.b)-&gt;X = 10</c> (an interior that
/// merely *starts* with an identifier but isn't a valid parameter list) hit a
/// genuine GS0005 once the lambda-parameter-list parse choked on the stray
/// <c>.</c>.
/// </para>
/// </summary>
public class Issue2002ParenthesizedArrowAssignmentParserTests
{
    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            yield return child;
            foreach (var d in Descendants(child))
            {
                yield return d;
            }
        }
    }

    [Theory]
    [InlineData("(p)->X = 10")]
    [InlineData("(a.b)->X = 10")]
    [InlineData("(arr[0])->X = 10")]
    [InlineData("(*pp)->X = 10")]
    [InlineData("(getPtr())->X = 10")]
    public void ParenthesizedArrowReceiver_AssignmentTarget_ParsesWithoutGS0005(string statement)
    {
        var source = $$"""
            unsafe func run() {
                {{statement}}
            }
            """;

        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0005");
        Assert.Empty(tree.Diagnostics);

        var assignment = Descendants(tree.Root).OfType<MemberFieldAssignmentExpressionSyntax>().SingleOrDefault();
        Assert.NotNull(assignment);
        Assert.Equal(SyntaxKind.RightArrowToken, assignment.DotToken.Kind);
        Assert.Equal("X", assignment.FieldIdentifier.Text);
    }

    [Fact]
    public void DoubleIndirection_ParenthesizedDerefArrow_AssignmentTarget_Parses()
    {
        // The motivating double-indirection shape from the issue:
        // `(*pp)->X = value`, where `pp` is itself a pointer-to-pointer.
        const string source = """
            unsafe func run() {
                (*pp)->X = 77
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var assignment = Descendants(tree.Root).OfType<MemberFieldAssignmentExpressionSyntax>().Single();
        var derefReceiver = Assert.IsType<UnaryExpressionSyntax>(assignment.Receiver);
        Assert.Equal(SyntaxKind.StarToken, derefReceiver.OperatorToken.Kind);
        var parenthesized = Assert.IsType<ParenthesizedExpressionSyntax>(derefReceiver.Operand);
        var innerDeref = Assert.IsType<UnaryExpressionSyntax>(parenthesized.Expression);
        Assert.Equal(SyntaxKind.StarToken, innerDeref.OperatorToken.Kind);
    }

    // ADR-0122 §4: outside an unsafe context, `->` is exclusively the lambda
    // operator (there is no pointer-arrow feature to disambiguate against),
    // so a genuinely malformed lambda parameter list must keep reporting a
    // diagnostic there — this fix is scoped to unsafe contexts only.
    [Fact]
    public void OutsideUnsafeContext_DottedParenthesizedArrow_StillReportsDiagnostic()
    {
        const string source = """
            func run() {
                (a.b)->X = 10
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    // Non-assignment parenthesized-arrow shapes are unaffected by this fix and
    // keep their pre-existing (ADR-documented) lambda interpretation for the
    // maximally-ambiguous bare-single-identifier interior.
    [Fact]
    public void BareIdentifierParens_NonAssignmentArrowBody_StillParsesAsLambda()
    {
        const string source = """
            unsafe func run() {
                var f = (p) -> p + 1
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.Single(Descendants(tree.Root).OfType<LambdaExpressionSyntax>());
    }

    [Fact]
    public void MultiParamLambda_StillParsesAsLambda_InUnsafeContext()
    {
        const string source = """
            unsafe func run() {
                var f = (a, b) -> a + b
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.Single(Descendants(tree.Root).OfType<LambdaExpressionSyntax>());
    }
}
