// <copyright file="WithExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents `expr with { Field = value, ... }` data-struct copy sugar.
partial class WithExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:WithExpressionSyntax) class.
    /// @param receiver The copied expression.
    /// @param withToken The contextual `with` token.
    /// @param openBraceToken The opening brace.
    /// @param initializers The field overrides.
    /// @param closeBraceToken The closing brace.
    init(
        receiver ExpressionSyntax,
        withToken SyntaxToken,
        openBraceToken SyntaxToken,
        initializers SeparatedSyntaxList[FieldInitializerSyntax],
        closeBraceToken SyntaxToken
    ) : base(receiver.SyntaxTree) {
        Receiver = receiver
        WithToken = withToken
        OpenBraceToken = openBraceToken
        Initializers = initializers
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.WithExpression

    /// Gets the copied expression.
    prop Receiver ExpressionSyntax {
        get;
    }

    /// Gets the contextual `with` token.
    prop WithToken SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the field overrides.
    prop Initializers SeparatedSyntaxList[FieldInitializerSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
