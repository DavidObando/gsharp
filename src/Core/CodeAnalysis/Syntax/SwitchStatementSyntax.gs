// <copyright file="SwitchStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `switch` statement of the form
/// `switch expr { case A { … } case B { … } default { … } }`.
/// Cases do not fall through; arms are independent.
partial class SwitchStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:SwitchStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param switchKeyword The `switch` keyword.
    /// @param expression The switched-on discriminant expression.
    /// @param openBraceToken The opening brace.
    /// @param cases The case arms.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        switchKeyword SyntaxToken,
        expression ExpressionSyntax,
        openBraceToken SyntaxToken,
        cases ImmutableArray[SwitchCaseSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        SwitchKeyword = switchKeyword
        Expression = expression
        OpenBraceToken = openBraceToken
        Cases = cases
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SwitchStatement

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

    /// Gets the case arms.
    prop Cases ImmutableArray[SwitchCaseSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
