// <copyright file="BoundReturnStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound return statement.
class BoundReturnStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundReturnStatement) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression to return, or `null` for a
    /// bare `return`.
    convenience init(syntax SyntaxNode?, expression BoundExpression?) {
        init(syntax, expression, false)
    }

    /// Initializes a new instance of the (cref:BoundReturnStatement) class with an
    /// explicit [`isRef`](paramref) flag (issue #490).
    /// @param syntax The originating syntax.
    /// @param expression The expression to return, or `null` for a
    /// bare `return`. When [`isRef`](paramref) is true,
    /// this is a (cref:BoundAddressOfExpression) wrapping the lvalue being returned by reference.
    /// @param isRef When `true`, the statement returns the value by managed pointer
    /// (the enclosing function must have `ReturnRefKind == Ref`).
    init(syntax SyntaxNode?, expression BoundExpression?, isRef bool) : base(syntax) {
        Expression = expression
        IsRef = isRef
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ReturnStatement

    /// Gets the expression to return, or `null` for a bare `return`
    /// in a function with no return value. The emitter and the bound-tree
    /// rewriter both test this before using it.
    prop Expression BoundExpression? {
        get;
    }

    /// Gets a value indicating whether this is a `return ref` statement (issue #490).
    /// When true, (cref:Expression) is a (cref:BoundAddressOfExpression) wrapping the lvalue.
    prop IsRef bool {
        get;
    }
}
