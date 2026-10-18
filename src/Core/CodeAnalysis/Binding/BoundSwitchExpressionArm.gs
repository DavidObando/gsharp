// <copyright file="BoundSwitchExpressionArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis

/// Bound arm of a switch expression.
class BoundSwitchExpressionArm : BoundNode {
    /// Initializes a new instance of the (cref:BoundSwitchExpressionArm) class.
    /// @param syntax The originating syntax.
    /// @param pattern The case pattern, or null for `default`.
    /// @param guard The optional boolean guard expression (`when` clause), or null.
    /// @param result The result expression.
    init(syntax SyntaxNode?, pattern BoundPattern?, $guard BoundExpression?, result BoundExpression) : base(syntax) {
        Pattern = pattern
        Guard = $guard
        Result = result
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.SwitchExpressionArm

    /// Gets the case pattern expression, or null when this arm is `default`.
    prop Pattern BoundPattern? {
        get;
    }

    /// Gets the optional boolean guard expression (`when` clause), or null when the arm has no guard.
    prop Guard BoundExpression? {
        get;
    }

    /// Gets the result expression.
    prop Result BoundExpression {
        get;
    }

    /// Gets a value indicating whether this is the `default` arm.
    @MemberNotNullWhen(false, "Pattern")
    prop IsDefault bool -> Pattern == nil

    /// Gets whether this arm matches every input without a guard.
    internal prop IsCatchAll bool -> Guard == nil && PatternMatchesAllInputs

    /// Gets whether every input reaches this arm's guard or result.
    internal prop PatternMatchesAllInputs bool -> Pattern == nil || Pattern is BoundDiscardPattern
}
