// <copyright file="BoundDereferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression representing the dereference operator `*expr`.
/// The operand must have type `*T` ((cref:ByRefTypeSymbol)); the result type is `T`.
class BoundDereferenceExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundDereferenceExpression) class.
    /// @param syntax The originating syntax.
    /// @param operand The pointer expression to dereference.
    init(syntax SyntaxNode?, operand BoundExpression) : base(syntax) {
        Operand = operand
        _type = if TypeSymbol.TryGetPointeeType(operand.Type, out var pointee) {
            pointee!!
        } else {
            TypeSymbol.Error
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.DereferenceExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the pointer operand being dereferenced.
    prop Operand BoundExpression {
        get;
    }
}
