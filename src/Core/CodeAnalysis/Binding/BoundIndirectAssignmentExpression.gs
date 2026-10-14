// <copyright file="BoundIndirectAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0060 §13: bound expression for an indirect assignment `*p = expr`. The
/// (cref:Pointer) is a pointer expression of type `*T`
/// ((cref:ByRefTypeSymbol)); the (cref:Value) is of type `T`. The
/// emitter lowers to `<load-address> <value> stind.*` and the
/// expression has type `T` (the value that was stored).
class BoundIndirectAssignmentExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundIndirectAssignmentExpression) class.
    /// @param syntax The originating syntax (may be null).
    /// @param pointer The pointer expression (type `*T`).
    /// @param value The value being stored through the pointer (type `T`).
    init(syntax SyntaxNode?, pointer BoundExpression, value BoundExpression) : base(syntax) {
        Pointer = pointer
        Value = value
        _type = if TypeSymbol.TryGetPointeeType(pointer.Type, out var pointee) {
            pointee!!
        } else {
            TypeSymbol.Error
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.IndirectAssignmentExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the pointer expression being assigned through.
    prop Pointer BoundExpression {
        get;
    }

    /// Gets the value being stored through the pointer.
    prop Value BoundExpression {
        get;
    }
}
