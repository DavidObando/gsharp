// <copyright file="BoundUnaryExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound unary expression.
class BoundUnaryExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundUnaryExpression) class.
    /// @param syntax The originating syntax.
    /// @param op The bound unary operator.
    /// @param operand The bound expression.
    /// @param isChecked When true and [`op`](paramref) is a (cref:BoundUnaryOperatorKind.Negation)
    /// over an integral operand, the emitter and interpreter use overflow-trapping
    /// arithmetic (issue #2023, follow-up to #1881): a `checked(...)` expression or
    /// `checked { }` statement puts its arithmetic in this context; the default (no
    /// `checked` context) is unchecked, matching the C# project default.
    /// @param platformCheckMessage ADR-0186 §4: when non-`null`, this node is a
    /// <em>synthesized</em> platform coercion check rather than a user-written
    /// `!!`, and the string is the message its
    /// (cref:System.NullReferenceException) carries — naming the
    /// expression and the boundary that failed. Only observed for
    /// (cref:BoundUnaryOperatorKind.NullAssertion); every other operator
    /// ignores it.
    init(
        syntax SyntaxNode?,
        op BoundUnaryOperator,
        operand BoundExpression,
        isChecked bool = false,
        platformCheckMessage string? = nil
    ) : base(syntax) {
        Op = op
        Operand = operand
        IsChecked = isChecked
        PlatformCheckMessage = platformCheckMessage
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.UnaryExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Op.Type

    /// Gets the bound unary operator.
    prop Op BoundUnaryOperator {
        get;
    }

    /// Gets the bound expression.
    prop Operand BoundExpression {
        get;
    }

    /// Gets a value indicating whether this operator runs in a checked /
    /// overflow-trapping context (issue #2023). Only observed for
    /// (cref:BoundUnaryOperatorKind.Negation) on integral operands.
    prop IsChecked bool {
        get;
    }

    /// Gets ADR-0186 §4's runtime-check message, or `null` for
    /// a user-written `!!`.
    ///
    /// A non-null value marks this node as the check the compiler inserted at
    /// a `T! -> T` coercion. The distinction is observable in two
    /// places and nowhere else: the emitter selects the
    /// `NullReferenceException(string)` constructor instead of the
    /// parameterless one, and `--platform-nil-checks=off` suppresses
    /// insertion of these nodes while leaving every user-written `!!`
    /// exactly as it is.
    ///
    /// There is no third consumer, and an earlier draft of this comment
    /// wrongly claimed one: G# has no separate expression interpreter —
    /// `Interpreter.Tests` drives emitted IL — so the emitter is the
    /// only thing that reads this.
    prop PlatformCheckMessage string? {
        get;
    }

    /// Gets a value indicating whether this node is the unwrap of a narrowed
    /// value-type nullable read (issue #4986), whose (cref:Operand) is the
    /// read of the original `Nullable<T>` storage. Member access binding
    /// reads it to fall back to `Nullable<T>` members such as `Value` and
    /// `HasValue` when the narrowed type has no member of that name. Only the
    /// binder observes it; rewriters that rebuild the node may drop it.
    internal prop IsNarrowingUnwrap bool {
        get;
        init;
    }

    /// Gets whether this node extracts a nullable value for an explicit conversion.
    internal prop IsConversionUnwrap bool {
        get;
        init;
    }
}
