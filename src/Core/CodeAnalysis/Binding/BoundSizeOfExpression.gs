// <copyright file="BoundSizeOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0122 §4 / issue #1034. Bound `sizeof(T)` expression used by the
/// unmanaged-pointer arithmetic lowering to scale offsets by the size of a
/// pointee whose size is not known at G# compile time (a user/value struct).
/// Emits the CIL `sizeof <T>` opcode (an `int32` byte count).
/// Its result type is `int32`.
class BoundSizeOfExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundSizeOfExpression) class.
    /// @param syntax The originating syntax (may be `null` for lowered nodes).
    /// @param measuredType The type whose unmanaged size is measured.
    init(syntax SyntaxNode?, measuredType TypeSymbol) : base(syntax) {
        MeasuredType = measuredType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.SizeOfExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Int32

    /// Gets the type whose unmanaged size is measured.
    prop MeasuredType TypeSymbol {
        get;
    }
}
