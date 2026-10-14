// <copyright file="BoundThrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax

/// Bound `throw expr` statement.
class BoundThrowStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundThrowStatement) class.
    /// @param syntax The originating syntax.
    /// @param expression The bound exception expression.
    convenience init(syntax SyntaxNode?, expression BoundExpression) {
        init(syntax, expression, nil)
    }

    /// Initializes a new instance of the (cref:BoundThrowStatement) class
    /// for a compiler-generated throw with an interpreter diagnostic.
    /// @param syntax The originating syntax.
    /// @param expression The bound exception expression.
    /// @param diagnosticDescriptor The interpreter diagnostic.
    internal init(syntax SyntaxNode?, expression BoundExpression, diagnosticDescriptor DiagnosticDescriptor?) : base(
        syntax
    ) {
        Expression = expression
        DiagnosticDescriptor = diagnosticDescriptor
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ThrowStatement

    /// Gets the bound exception expression.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the interpreter diagnostic for a compiler-generated throw.
    internal prop DiagnosticDescriptor DiagnosticDescriptor? {
        get;
    }
}
