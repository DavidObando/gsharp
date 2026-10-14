// <copyright file="BoundAwaitExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound `await` expression (Phase 5.1 / ADR-0023). At runtime the
/// operand is a (cref:System.Threading.Tasks.Task) (or
/// (cref:System.Threading.Tasks.Task{TResult})); the expression yields
/// the unwrapped result type.
class BoundAwaitExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundAwaitExpression) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression being awaited.
    /// @param type The unwrapped type that the await yields.
    /// @param awaiterTypeSymbol The symbolic awaiter type used by lowering/emission.
    init(syntax SyntaxNode?, expression BoundExpression, type TypeSymbol, awaiterTypeSymbol TypeSymbol? = nil) : base(
        syntax
    ) {
        Expression = expression
        _type = type
        AwaiterTypeSymbol = awaiterTypeSymbol
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.AwaitExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the awaited expression. Its runtime value must be a `Task` or `Task[T]`.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the symbolic awaiter type used when the operand was bound through an erased placeholder CLR
    /// type.
    prop AwaiterTypeSymbol TypeSymbol? {
        get;
    }
}
