// <copyright file="Issue1609InterpolationHoleBalanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1609: <c>ScanInterpolationHoleCore</c> used a single shared counter
/// for <c>()[]{}</c> nesting inside a <c>${…}</c> interpolation hole. A stray
/// or mismatched <c>)</c>/<c>]</c> decremented that counter with no floor, so
/// it could drop below the level of the hole's own opening <c>{</c>; the
/// following <c>}</c> would then fail to match, and the scanner ran to EOF,
/// swallowing the rest of the file into one unterminated string token. The
/// fix tracks open delimiters by kind (a stack) so only the matching close
/// for the currently-open delimiter pops it; unmatched closes are ignored
/// instead of corrupting the depth used to find the hole's terminating
/// <c>}</c>.
/// </summary>
public class Issue1609InterpolationHoleBalanceTests
{
    [Fact]
    public void StrayCloseParen_InHole_DoesNotSwallowRestOfFile()
    {
        // Exact issue #1609 repro.
        var source = "let a = \"${ ) }\"\nlet b = 2\n";
        var tokens = SyntaxTree.ParseTokens(source, out var diagnostics);

        Assert.Empty(diagnostics);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.InterpolatedStringToken);

        // The `let b = 2` line must still lex as its own tokens, not be
        // absorbed into the string token.
        var identifiers = tokens.Where(t => t.Kind == SyntaxKind.IdentifierToken).Select(t => t.Text).ToArray();
        Assert.Contains("b", identifiers);
    }

    [Fact]
    public void StrayCloseBracket_InHole_DoesNotSwallowRestOfFile()
    {
        var source = "let a = \"${ ] }\"\nlet b = 2\n";
        var tokens = SyntaxTree.ParseTokens(source, out var diagnostics);

        Assert.Empty(diagnostics);
        var identifiers = tokens.Where(t => t.Kind == SyntaxKind.IdentifierToken).Select(t => t.Text).ToArray();
        Assert.Contains("b", identifiers);
    }

    [Fact]
    public void MismatchedCloseBracket_InsideOpenParen_IsIgnoredAndHoleStillClosesCorrectly()
    {
        // A ']' that doesn't match the innermost '(' must be ignored rather
        // than popping the '(' (or corrupting the tracking); the following
        // ')' must still close the '(' and the final '}' must still close
        // the hole normally.
        var source = "let a = \"${ (1] + 2) }\"\nlet b = 2\n";
        var tokens = SyntaxTree.ParseTokens(source, out var diagnostics);

        Assert.Empty(diagnostics);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.InterpolatedStringToken);
        var identifiers = tokens.Where(t => t.Kind == SyntaxKind.IdentifierToken).Select(t => t.Text).ToArray();
        Assert.Contains("b", identifiers);
    }

    [Fact]
    public void BalancedNestedBrackets_OfAllKinds_CloseHoleCorrectly()
    {
        var source = "let a = \"${ f(g[h(1)], {2}) }\"\nlet b = 2\n";
        var tokens = SyntaxTree.ParseTokens(source, out var diagnostics);

        Assert.Empty(diagnostics);
        Assert.Contains(tokens, t => t.Kind == SyntaxKind.InterpolatedStringToken);
        var identifiers = tokens.Where(t => t.Kind == SyntaxKind.IdentifierToken).Select(t => t.Text).ToArray();
        Assert.Contains("b", identifiers);
    }

    [Fact]
    public void NestedInterpolationHole_WithStrayCloseParenInInnerString_StillClosesOuterHole()
    {
        // A nested "${...}" inside the hole (its own string literal with an
        // interpolation) must be skipped wholesale by
        // SkipInterpolationNestedLiteral; a stray ')' inside that nested hole
        // must not corrupt the outer hole's own tracking.
        var source = "let a = \"${ \"${ ) }\" }\"\nlet b = 2\n";
        var tokens = SyntaxTree.ParseTokens(source, out var diagnostics);

        Assert.Empty(diagnostics);
        var identifiers = tokens.Where(t => t.Kind == SyntaxKind.IdentifierToken).Select(t => t.Text).ToArray();
        Assert.Contains("b", identifiers);
    }
}
