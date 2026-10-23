// <copyright file="FieldAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a field assignment `variable.Field = value` (Phase 3.B.1).
partial class FieldAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:FieldAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param receiver The receiver identifier.
    /// @param dotToken The dot.
    /// @param fieldIdentifier The field name.
    /// @param equalsToken The `=` token.
    /// @param value The value expression.
    init(
        syntaxTree SyntaxTree,
        receiver SyntaxToken,
        dotToken SyntaxToken,
        fieldIdentifier SyntaxToken,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) : base(syntaxTree) {
        Receiver = receiver
        DotToken = dotToken
        FieldIdentifier = fieldIdentifier
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FieldAssignmentExpression

    /// Gets the receiver identifier.
    prop Receiver SyntaxToken {
        get;
    }

    /// Gets the dot token.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the field identifier.
    prop FieldIdentifier SyntaxToken {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
