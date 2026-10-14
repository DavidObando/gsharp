// <copyright file="SwitchCaseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single arm of a `switch` statement: either a `case` with
/// a value expression or a `default` arm. The body is always a block.
class SwitchCaseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:SwitchCaseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `case` or `default` keyword.
    /// @param value The case value pattern (null for `default`).
    /// @param whenKeyword The optional `when` contextual keyword introducing a? guard, or null.
    /// @param guard The optional boolean guard expression following `when`, or null.
    /// @param body The case body block.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        value PatternSyntax?,
        whenKeyword SyntaxToken?,
        $guard ExpressionSyntax?,
        body BlockStatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        Value = value
        WhenKeyword = whenKeyword
        Guard = $guard
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SwitchCase

    /// Gets the `case` or `default` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the case value pattern, or null when this arm is `default`.
    prop Value PatternSyntax? {
        get;
    }

    /// Gets the optional `when` contextual keyword token introducing a? guard, or null when the arm has no
    /// guard.
    prop WhenKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional boolean guard expression following `when`, or null when the arm has no guard.
    prop Guard ExpressionSyntax? {
        get;
    }

    /// Gets the case body block.
    prop Body BlockStatementSyntax {
        get;
    }

    /// Gets a value indicating whether this is the `default` arm.
    prop IsDefault bool -> Keyword.Kind == SyntaxKind.DefaultKeyword
}
