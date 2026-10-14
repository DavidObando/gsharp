// <copyright file="BoundTypeParameterConstructionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression representing the construction of a type parameter under a
/// `init()` default-constructor constraint — the G# spelling `T()`
/// where the enclosing generic declares `[T init()]` (issue #988; spelled new() before issue #997).
/// Lowered at emit time to a reified
/// `call !!0 System.Activator::CreateInstance<!!T>()` (ADR-0087),
/// which produces a real instance for both reference types that expose a public
/// parameterless constructor and value types.
class BoundTypeParameterConstructionExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundTypeParameterConstructionExpression) class.
    /// @param syntax The originating syntax.
    /// @param typeParameter The constrained type parameter being constructed.
    init(syntax SyntaxNode?, typeParameter TypeParameterSymbol) : base(syntax) {
        TypeParameter = typeParameter
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.TypeParameterConstructionExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeParameter

    /// Gets the constrained type parameter being constructed.
    prop TypeParameter TypeParameterSymbol {
        get;
    }
}
