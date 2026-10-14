// <copyright file="BoundConversionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound conversion expression.
class BoundConversionExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundConversionExpression) class.
    /// @param syntax The originating syntax.
    /// @param type The type symbol.
    /// @param expression The expression to convert.
    /// @param isChecked When true, the emitter must use overflow-checking `conv.ovf.*` opcodes for
    /// the numeric narrowing portion of the conversion. The binder does not yet surface
    /// `checked` contexts (issue #421 P2-5), so callers default to false; the flag
    /// exists so the emitter is ready when the binder begins distinguishing checked vs.
    /// unchecked conversions.
    init(syntax SyntaxNode?, type TypeSymbol, expression BoundExpression, isChecked bool = false) : base(syntax) {
        _type = type
        Expression = expression
        IsChecked = isChecked
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConversionExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the expression to convert.
    prop Expression BoundExpression {
        get;
    }

    /// Gets a value indicating whether this conversion runs in a checked / overflow-trapping
    /// context. When true, the emitter selects `conv.ovf.*` opcodes so a numeric
    /// narrowing that loses information traps at runtime via (cref:System.OverflowException)
    /// instead of silently truncating.
    prop IsChecked bool {
        get;
    }
}
