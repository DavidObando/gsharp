// <copyright file="BoundIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound indexed assignment `target[index] = value`. The target is either
/// a simple variable reference or, after closure-boxing lowering, an arbitrary
/// expression (e.g. `boxLocal.Value` for a boxed captured variable —
/// issue #618).
class BoundIndexAssignmentExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundIndexAssignmentExpression) class.
    /// @param syntax The originating syntax.
    /// @param target The target variable holding the array.
    /// @param index The index expression.
    /// @param value The value expression.
    /// @param elementType The element type of the array.
    convenience init(
        syntax SyntaxNode?,
        target VariableSymbol,
        index BoundExpression,
        value BoundExpression,
        elementType TypeSymbol
    ) {
        init(syntax, target, ImmutableArray.Create(index), value, elementType)
    }

    /// Initializes a new instance of the (cref:BoundIndexAssignmentExpression) class.
    /// @param syntax Originating syntax.
    /// @param target Target variable.
    /// @param indices Index expressions.
    /// @param value Assigned value.
    /// @param elementType Element type.
    init(
        syntax SyntaxNode?,
        target VariableSymbol,
        indices ImmutableArray[BoundExpression],
        value BoundExpression,
        elementType TypeSymbol
    ) : base(syntax) {
        Target = target
        Indices = indices
        Value = value
        _type = elementType
    }

    private convenience init(
        syntax SyntaxNode?,
        targetExpression BoundExpression,
        index BoundExpression,
        value BoundExpression,
        elementType TypeSymbol
    ) {
        init(syntax, targetExpression, ImmutableArray.Create(index), value, elementType)
    }

    private init(
        syntax SyntaxNode?,
        targetExpression BoundExpression,
        indices ImmutableArray[BoundExpression],
        value BoundExpression,
        elementType TypeSymbol
    ) : base(syntax) {
        TargetExpression = targetExpression
        Indices = indices
        Value = value
        _type = elementType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.IndexAssignmentExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the target variable holding the array.
    prop Target VariableSymbol? {
        get;
    }

    /// Gets the expression-based target, or `null` when the simple
    /// (cref:Target) variable form is used. When non-null, the emitter
    /// evaluates this expression to produce the array/map/slice reference
    /// instead of loading (cref:Target).
    prop TargetExpression BoundExpression? {
        get;
    }

    /// Gets the index expression.
    prop Index BoundExpression -> Indices[0]

    /// Gets index expressions.
    prop Indices ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets the value expression.
    prop Value BoundExpression {
        get;
    }

    shared {
        /// Creates an index assignment with an expression-based target. Used after
        /// closure-boxing lowering when the original target local has been replaced
        /// by a field access through a box (issue #618).
        /// @param syntax The originating syntax, or `null` for synthesized nodes.
        /// @param targetExpression The expression that produces the array/map/slice reference.
        /// @param index The index expression.
        /// @param value The value to assign.
        /// @param elementType The element type of the array.
        /// @returns A new (cref:BoundIndexAssignmentExpression) with an expression target.
        func WithExpressionTarget(
            syntax SyntaxNode?,
            targetExpression BoundExpression,
            index BoundExpression,
            value BoundExpression,
            elementType TypeSymbol
        ) BoundIndexAssignmentExpression {
            return BoundIndexAssignmentExpression(syntax, targetExpression, index, value, elementType)
        }

        /// Creates an expression-target indexed assignment with multiple indices.
        /// @param syntax Originating syntax.
        /// @param targetExpression Target expression.
        /// @param indices Index expressions.
        /// @param value Assigned value.
        /// @param elementType Element type.
        /// @returns Bound indexed assignment.
        func WithExpressionTarget(
            syntax SyntaxNode?,
            targetExpression BoundExpression,
            indices ImmutableArray[BoundExpression],
            value BoundExpression,
            elementType TypeSymbol
        ) BoundIndexAssignmentExpression {
            return BoundIndexAssignmentExpression(syntax, targetExpression, indices, value, elementType)
        }
    }
}
