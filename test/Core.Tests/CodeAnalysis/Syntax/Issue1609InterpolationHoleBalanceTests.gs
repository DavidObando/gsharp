// <copyright file="Issue1609InterpolationHoleBalanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1609: `ScanInterpolationHoleCore` used a single shared counter
/// for `()[]{}` nesting inside a `${…}` interpolation hole. A stray
/// or mismatched `)`/`]` decremented that counter with no floor, so
/// it could drop below the level of the hole's own opening `{`; the
/// following `}` would then fail to match, and the scanner ran to EOF,
/// swallowing the rest of the file into one unterminated string token. The
/// fix tracks open delimiters by kind (a stack) so only the matching close
/// for the currently-open delimiter pops it; unmatched closes are ignored
/// instead of corrupting the depth used to find the hole's terminating
/// `}`.
open class Issue1609InterpolationHoleBalanceTests {
    @Fact
    func StrayCloseParen_InHole_DoesNotSwallowRestOfFile() {
        // Exact issue #1609 repro.
        let source = `let a = "${ ) }"
let b = 2
`
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.InterpolatedStringToken)
        // The `let b = 2` line must still lex as its own tokens, not be
        // absorbed into the string token.
        let identifiers = tokens
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .Select((t SyntaxToken) -> t.Text)
            .ToArray()
        Assert.Contains("b", identifiers)
    }

    @Fact
    func StrayCloseBracket_InHole_DoesNotSwallowRestOfFile() {
        let source = `let a = "${ ] }"
let b = 2
`
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        let identifiers = tokens
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .Select((t SyntaxToken) -> t.Text)
            .ToArray()
        Assert.Contains("b", identifiers)
    }

    @Fact
    func MismatchedCloseBracket_InsideOpenParen_IsIgnoredAndHoleStillClosesCorrectly() {
        // A ']' that doesn't match the innermost '(' must be ignored rather
        // than popping the '(' (or corrupting the tracking); the following
        // ')' must still close the '(' and the final '}' must still close
        // the hole normally.
        let source = `let a = "${ (1] + 2) }"
let b = 2
`
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.InterpolatedStringToken)
        let identifiers = tokens
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .Select((t SyntaxToken) -> t.Text)
            .ToArray()
        Assert.Contains("b", identifiers)
    }

    @Fact
    func BalancedNestedBrackets_OfAllKinds_CloseHoleCorrectly() {
        let source = `let a = "${ f(g[h(1)], {2}) }"
let b = 2
`
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.InterpolatedStringToken)
        let identifiers = tokens
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .Select((t SyntaxToken) -> t.Text)
            .ToArray()
        Assert.Contains("b", identifiers)
    }

    @Fact
    func NestedInterpolationHole_WithStrayCloseParenInInnerString_StillClosesOuterHole() {
        // A nested "${...}" inside the hole (its own string literal with an
        // interpolation) must be skipped wholesale by
        // SkipInterpolationNestedLiteral; a stray ')' inside that nested hole
        // must not corrupt the outer hole's own tracking.
        let source = `let a = "${ "${ ) }" }"
let b = 2
`
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        Assert.Empty(diagnostics)
        let identifiers = tokens
            .Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
            .Select((t SyntaxToken) -> t.Text)
            .ToArray()
        Assert.Contains("b", identifiers)
    }
}
