// <copyright file="InterpolationFragment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// A raw fragment produced by the lexer for an interpolated string literal.
/// Stored inside the (cref:InterpolationFragments) wrapper attached to an
/// (cref:SyntaxKind.InterpolatedStringToken).
/// Expression fragments still hold un-parsed text; the parser is responsible
/// for lexing+parsing them into (cref:ExpressionSyntax) nodes when it
/// builds an (cref:InterpolatedStringExpressionSyntax).
struct InterpolationFragment {
    private init(isExpression bool, text string, position int32) {
        IsExpression = isExpression
        Text = text
        Position = position
    }

    /// Gets a value indicating whether this fragment is an expression (true) or literal text (false).
    prop IsExpression bool {
        get;
    }

    /// Gets the fragment's source text (literal content or un-parsed expression source).
    prop Text string {
        get;
    }

    /// Gets the position in the original source where the fragment text begins (used for diagnostics on
    /// expression fragments).
    prop Position int32 {
        get;
    }

    shared {
        /// Creates a literal-text fragment.
        /// @param text Literal text.
        /// @returns The fragment.
        func FromText(text string) InterpolationFragment -> InterpolationFragment(
            isExpression: false,
            text,
            position: 0
        )

        /// Creates an expression fragment whose [`text`](paramref) still needs parsing.
        /// @param text Un-parsed expression source.
        /// @param position Position in the enclosing source text where the expression starts.
        /// @returns The fragment.
        func FromExpression(text string, position int32) InterpolationFragment -> InterpolationFragment(
            isExpression: true,
            text,
            position
        )
    }
}
