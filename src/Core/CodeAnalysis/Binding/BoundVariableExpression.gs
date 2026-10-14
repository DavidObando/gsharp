// <copyright file="BoundVariableExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound variable expression.
class BoundVariableExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundVariableExpression) class.
    /// @param syntax The originating syntax.
    /// @param variable The variable symbol.
    convenience init(syntax SyntaxNode?, variable VariableSymbol) {
        init(syntax, variable, nil)
    }

    /// Initializes a new instance of the (cref:BoundVariableExpression)
    /// class with a narrowed type. Phase 3.C.4: used by smart-cast flow
    /// analysis to surface a non-nullable view of a nullable variable
    /// inside an `if x != nil { ... }` guard, without losing the
    /// underlying symbol identity (so the evaluator still loads from the
    /// original slot).
    /// @param syntax The originating syntax.
    /// @param variable The variable symbol.
    /// @param narrowedType The narrowed type to report from
    /// (cref:Type). Pass `null` to use the variable's declared
    /// type.
    init(syntax SyntaxNode?, variable VariableSymbol, narrowedType TypeSymbol?) : base(syntax) {
        Variable = variable
        NarrowedType = narrowedType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.VariableExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> NarrowedType ?? Variable.Type

    /// Gets the variable symbol.
    prop Variable VariableSymbol {
        get;
    }

    /// Gets the narrowed type, or `null` if the variable's declared
    /// type is in effect.
    prop NarrowedType TypeSymbol? {
        get;
    }
}
