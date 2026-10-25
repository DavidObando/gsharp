// <copyright file="IndirectCompoundAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #1925 / #4350: syntax for a compound assignment through addressable
/// storage, including variables, fields, indexers, `*p op= expr`, and
/// `GetRef() op= expr`.
/// Complements (cref:IndirectAssignmentExpressionSyntax), which handles
/// the plain `=` case. The binder evaluates the target address exactly
/// once (via a synthesized temp local) and lowers the node to the equivalent
/// `*tmp = *tmp op value`.
@SyntaxChildSourceOrder
partial class IndirectCompoundAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:IndirectCompoundAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The addressable assignment target.
    /// @param operatorToken The compound assignment token (e.g. `+=`).
    /// @param value The right-hand-side expression on the right of the operator.
    /// @param returnsPreviousValue Whether this node represents postfix increment/decrement and therefore
    /// yields the value read before the write.
    /// @param isIncrementDecrement Whether this node originated from a `++` or `--` expression.
    init(
        syntaxTree SyntaxTree,
        target ExpressionSyntax,
        operatorToken SyntaxToken,
        value ExpressionSyntax,
        returnsPreviousValue bool = false,
        isIncrementDecrement bool = false
    ) : base(syntaxTree) {
        Target = target
        OperatorToken = operatorToken
        Value = value
        ReturnsPreviousValue = returnsPreviousValue
        IsIncrementDecrement = isIncrementDecrement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IndirectCompoundAssignmentExpression

    /// Gets the addressable compound-assignment target.
    prop Target ExpressionSyntax {
        get;
    }

    /// Gets the compound assignment operator token.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the right-hand-side value on the right of the operator.
    prop Value ExpressionSyntax {
        get;
    }

    /// Gets a value indicating whether this expression yields the pre-write value.
    prop ReturnsPreviousValue bool {
        get;
    }

    /// Gets a value indicating whether this expression originated from increment/decrement syntax.
    prop IsIncrementDecrement bool {
        get;
    }
}
