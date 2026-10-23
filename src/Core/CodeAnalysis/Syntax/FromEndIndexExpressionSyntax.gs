// <copyright file="FromEndIndexExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #1022: represents a C#-style "from-end" index marker `^n` used in
/// the leading position of an index or range bound (`a[^1]`,
/// `a[1..^1]`, `a[^2..]`). The offset is measured from the end of the
/// indexed value, mapping to `System.Index(n, fromEnd: true)` semantics:
/// the concrete offset is `length - n`.
/// @remarks This node is produced only by the index-argument parser, so the prefix
/// `^` one's-complement and infix `^` bitwise-XOR meanings of the hat
/// token are unchanged everywhere else in the grammar.
partial class FromEndIndexExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:FromEndIndexExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param hatToken The leading `^` marker token.
    /// @param operand The from-end offset expression (`n` in `^n`).
    init(syntaxTree SyntaxTree, hatToken SyntaxToken, operand ExpressionSyntax) : base(syntaxTree) {
        HatToken = hatToken
        Operand = operand
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FromEndIndexExpression

    /// Gets the leading `^` marker token.
    prop HatToken SyntaxToken {
        get;
    }

    /// Gets the from-end offset expression.
    prop Operand ExpressionSyntax {
        get;
    }
}
