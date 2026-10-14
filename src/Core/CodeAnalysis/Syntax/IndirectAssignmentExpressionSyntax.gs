// <copyright file="IndirectAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0060 §13 / issue #4350: syntax for assignment through addressable
/// storage, including explicit pointer dereference (`*p = expr`) and a
/// writable ref-returning call (`GetRef() = expr`). The binder lowers
/// both to a `BoundIndirectAssignmentExpression`; the emitter lowers to
/// `<load-address> <value> stind.*`.
class IndirectAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IndirectAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The pointer dereference or writable ref-returning call.
    /// @param equalsToken The `=` token.
    /// @param value The right-hand-side expression being stored through the pointer.
    init(syntaxTree SyntaxTree, target ExpressionSyntax, equalsToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        Target = target
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IndirectAssignmentExpression

    /// Gets the addressable assignment target.
    prop Target ExpressionSyntax {
        get;
    }

    /// Gets the `=` token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the right-hand-side value being stored.
    prop Value ExpressionSyntax {
        get;
    }
}
