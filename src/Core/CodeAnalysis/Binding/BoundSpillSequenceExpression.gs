// <copyright file="BoundSpillSequenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// An intermediate expression node produced by the `SpillSequenceSpiller`
/// (spec §7). It carries a list of spill-temp locals, a sequence of
/// statements that must execute before the value is observed, and a
/// final value expression. After the spiller pass completes, no
/// `BoundSpillSequenceExpression` nodes should survive at statement
/// top-level — they are flattened into the enclosing statement list.
class BoundSpillSequenceExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundSpillSequenceExpression) class.
    /// @param syntax The originating syntax.
    /// @param locals Spill-temp locals owned by this sequence.
    /// @param sideEffects Statements that must run before the value is observed.
    /// @param value The final value expression.
    init(
        syntax SyntaxNode?,
        locals ImmutableArray[LocalVariableSymbol],
        sideEffects ImmutableArray[BoundStatement],
        value BoundExpression
    ) : base(syntax) {
        Locals = locals
        SideEffects = sideEffects
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.SpillSequenceExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Value.Type

    /// Gets the spill-temp locals owned by this sequence.
    prop Locals ImmutableArray[LocalVariableSymbol] {
        get;
    }

    /// Gets the statements that must run before the value is observed.
    prop SideEffects ImmutableArray[BoundStatement] {
        get;
    }

    /// Gets the final value expression.
    prop Value BoundExpression {
        get;
    }
}
