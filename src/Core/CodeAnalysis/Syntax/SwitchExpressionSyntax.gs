// <copyright file="SwitchExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `switch` expression of the form
/// `switch expr { case A -> r1 default -> r2 }`.
partial class SwitchExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:SwitchExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param switchKeyword The `switch` keyword.
    /// @param expression The switched-on discriminant expression.
    /// @param openBraceToken The opening brace.
    /// @param arms The switch-expression arms.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        switchKeyword SyntaxToken,
        expression ExpressionSyntax,
        openBraceToken SyntaxToken,
        arms ImmutableArray[SwitchExpressionArmSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        SwitchKeyword = switchKeyword
        Expression = expression
        OpenBraceToken = openBraceToken
        Arms = arms
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SwitchExpression

    /// Gets the `switch` keyword.
    prop SwitchKeyword SyntaxToken {
        get;
    }

    /// Gets the discriminant expression.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the switch-expression arms.
    prop Arms ImmutableArray[SwitchExpressionArmSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
