// <copyright file="EventSubscriptionExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Stream B′: `receiver.Event += handler` / `receiver.Event -= handler`
/// subscription to a CLR event. The (cref:LeftHandSide) is the full
/// member-access chain ending at the event name (so multi-segment receivers
/// such as `foo.Bar.Baz.Event += h` are captured naturally as an
/// (cref:AccessorExpressionSyntax)).
@SyntaxChildSourceOrder
partial class EventSubscriptionExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:EventSubscriptionExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param leftHandSide The accessor chain identifying the event (receiver.Event).
    /// @param operatorToken The `+=` or `-=` token.
    /// @param value The handler expression on the right side.
    /// @param returnsPreviousValue Whether the expression yields the value read before the write.
    /// @param isIncrementDecrement Whether this node originated from a `++` or `--` expression.
    init(
        syntaxTree SyntaxTree,
        leftHandSide ExpressionSyntax,
        operatorToken SyntaxToken,
        value ExpressionSyntax,
        returnsPreviousValue bool = false,
        isIncrementDecrement bool = false
    ) : base(syntaxTree) {
        LeftHandSide = leftHandSide
        OperatorToken = operatorToken
        Value = value
        ReturnsPreviousValue = returnsPreviousValue
        IsIncrementDecrement = isIncrementDecrement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.EventSubscriptionExpression

    /// Gets the member-access chain identifying the event.
    prop LeftHandSide ExpressionSyntax {
        get;
    }

    /// Gets the `+=` or `-=` token.
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the handler expression on the right-hand side.
    prop Value ExpressionSyntax {
        get;
    }

    /// Gets a value indicating whether this expression yields the pre-write value.
    prop ReturnsPreviousValue bool {
        get;
    }

    /// Gets a value indicating whether this expression originated from increment/decrement syntax.
    prop IsIncrementDecrement bool {
        get;
    }
}
