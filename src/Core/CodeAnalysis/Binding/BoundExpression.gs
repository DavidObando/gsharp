// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression.
abstract class BoundExpression : BoundNode {
    /// Initializes a new instance of the (cref:BoundExpression) class.
    /// @param syntax The originating syntax.
    protected init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the bound expression type.
    abstract prop Type TypeSymbol {
        get;
    }

    /// Gets or sets the source operand of a binder-created implicit conversion.
    /// This binding-time provenance is not a tree child or a lowering contract.
    internal prop ImplicitConversionOperand BoundExpression? {
        get;
        set;
    }

    /// Gets the compile-time constant value of this expression — the Roslyn
    /// `ConstantValue` analogue (ADR-0169). `HasValue` is false
    /// when the expression has no compile-time constant; a constant null
    /// literal reports `HasValue` true with a null `Value`.
    open prop ConstantValue OptionalValue -> default(OptionalValue)
}
