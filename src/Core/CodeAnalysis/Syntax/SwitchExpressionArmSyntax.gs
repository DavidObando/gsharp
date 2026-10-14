// <copyright file="SwitchExpressionArmSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single arm of a `switch` expression.
class SwitchExpressionArmSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:SwitchExpressionArmSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `case` or `default` keyword.
    /// @param value The case value pattern, or null for `default`.
    /// @param whenKeyword The optional `when` contextual keyword introducing a? guard, or null.
    /// @param guard The optional boolean guard expression following `when`, or null.
    /// @param arrowToken The `:` (preferred) or `->` (deprecated, ADR-0074) separator token.
    /// @param result The result expression for this arm.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        value PatternSyntax?,
        whenKeyword SyntaxToken?,
        $guard ExpressionSyntax?,
        arrowToken SyntaxToken,
        result ExpressionSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        Value = value
        WhenKeyword = whenKeyword
        Guard = $guard
        ArrowToken = arrowToken
        Result = result
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SwitchExpressionArm

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

    /// Gets the separator token between the pattern and the result expression. Either `:` (ADR-0074,
    /// preferred) or `->` (deprecated, warns with GS0302).
    prop ArrowToken SyntaxToken {
        get;
    }

    /// Gets the result expression.
    prop Result ExpressionSyntax {
        get;
    }

    /// Gets a value indicating whether this is the `default` arm.
    prop IsDefault bool -> Keyword.Kind == SyntaxKind.DefaultKeyword
}
