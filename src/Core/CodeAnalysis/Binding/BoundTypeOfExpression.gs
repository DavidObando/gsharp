// <copyright file="BoundTypeOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound built-in `typeof(T)` expression (issue #143). Carries the
/// referenced (cref:TypeSymbol) payload; emits as
/// `ldtoken <T>` followed by a call to
/// `System.Type.GetTypeFromHandle`. Its result type is `System.Type`.
class BoundTypeOfExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundTypeOfExpression) class.
    /// @param syntax The originating syntax.
    /// @param operandType The type that this `typeof` references.
    /// @param systemType The `System.Type` symbol used as the result type.
    init(syntax SyntaxNode?, operandType TypeSymbol, systemType TypeSymbol) : base(syntax) {
        OperandType = operandType
        _type = systemType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.TypeOfExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the referenced type symbol.
    prop OperandType TypeSymbol {
        get;
    }
}
