// <copyright file="NamedTupleElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0172: a labeled tuple-literal element `name: expr`. Only valid as
/// a direct element of a tuple literal of two or more elements; derives from
/// (cref:ExpressionSyntax) so it slots into the tuple literal's
/// existing separated element list, and the binder unwraps it.
partial class NamedTupleElementSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:NamedTupleElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param nameToken The element-name identifier.
    /// @param colonToken The `:` separating name and value.
    /// @param expression The element value expression.
    init(syntaxTree SyntaxTree, nameToken SyntaxToken, colonToken SyntaxToken, expression ExpressionSyntax) : base(
        syntaxTree
    ) {
        NameToken = nameToken
        ColonToken = colonToken
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NamedTupleElement

    /// Gets the element-name identifier token.
    prop NameToken SyntaxToken {
        get;
    }

    /// Gets the `:` token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the element value expression.
    prop Expression ExpressionSyntax {
        get;
    }
}
