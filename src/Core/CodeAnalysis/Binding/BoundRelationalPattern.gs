// <copyright file="BoundRelationalPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound relational pattern.
class BoundRelationalPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundRelationalPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param op The operator.
    /// @param value The right-hand value.
    init(syntax SyntaxNode?, type TypeSymbol, op BoundBinaryOperator, value BoundExpression) : base(syntax, type) {
        Op = op
        Value = value
        // Issue #5681: the emitter reads `HasValue` through an address, so a value-type `T?` operand needs a local.
        // The emitter evaluates a value that is not a literal before the `HasValue` test, as the lifted operator does.
        if type is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) {
            InputVariable = LocalVariableSymbol("<relational-pattern-input>", isReadOnly: true, type)
            // A non-returning value (`never`) has nothing to store.
            if value.Type != TypeSymbol.Never &&
                (value.Type != nullable.UnderlyingType || value !is BoundLiteralExpression) {
                ValueVariable = LocalVariableSymbol("<relational-pattern-value>", isReadOnly: true, value.Type)
            }
        }
    }

    /// Initializes a `==` or `!=` relational pattern whose test is a bound binary operation.
    /// Issue #5688: the test reads the input and the value through (cref:BoundPatternOperandExpression) nodes.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param op The operator.
    /// @param value The right-hand value.
    /// @param inputVariable The temporary that holds the input.
    /// @param valueVariable The temporary that holds the value.
    /// @param test The operation `input op value`, of type `bool`.
    internal init(
        syntax SyntaxNode?,
        type TypeSymbol,
        op BoundBinaryOperator,
        value BoundExpression,
        inputVariable LocalVariableSymbol,
        valueVariable LocalVariableSymbol,
        test BoundExpression
    ) : base(syntax, type) {
        Op = op
        Value = value
        InputVariable = inputVariable
        ValueVariable = valueVariable
        Test = test
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.RelationalPattern

    /// Gets the relational operator.
    prop Op BoundBinaryOperator {
        get;
    }

    /// Gets the right-hand value expression.
    /// For a value-type `T?` input, the value has type `T` when the binder can compare the underlying values.
    prop Value BoundExpression {
        get;
    }

    /// Gets the temporary that holds a value-type `T?` input, or the input of a pattern with a (cref:Test).
    internal prop InputVariable LocalVariableSymbol? {
        get;
    }

    /// Gets the temporary that holds a value that is not a literal, or a `T?` value, for a value-type `T?` input.
    /// A pattern with a (cref:Test) always has this temporary.
    internal prop ValueVariable LocalVariableSymbol? {
        get;
    }

    /// Gets the `==` or `!=` operation that decides the match, or `nil` for an ordering pattern.
    internal prop Test BoundExpression? {
        get;
    }
}
