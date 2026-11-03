// <copyright file="BoundPatternOperandExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols

/// Reads a temporary that the emitter stores before it evaluates the test of a relational pattern.
/// Issue #5688: this node is not a variable reference, so capture and hoisting analyses do not see the temporary.
internal class BoundPatternOperandExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundPatternOperandExpression) class.
    /// @param variable The pattern temporary.
    init(variable LocalVariableSymbol) : base(nil) {
        Variable = variable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.PatternOperandExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Variable.Type

    /// Gets the pattern temporary.
    prop Variable LocalVariableSymbol {
        get;
    }
}
