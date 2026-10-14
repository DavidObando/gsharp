// <copyright file="BoundConditionalAddressExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0061: bound representation of a call-site-only conditional lvalue
/// address-of expression of the form `<cond> ? <lvalue> : <lvalue>`.
/// Produced by the binder from a (cref:ConditionalRefArgumentExpressionSyntax)
/// at the payload of a ref-kind modifier (`ref`/`out`/`in`) or as
/// the operand of `&`. The result type is `T&` (a
/// (cref:ByRefTypeSymbol)) where T is the common pointee type of the two
/// branches. Lowered to a CIL branch around two address-of forms feeding a
/// single managed pointer onto the evaluation stack.
class BoundConditionalAddressExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundConditionalAddressExpression) class.
    /// @param syntax The originating syntax.
    /// @param condition The condition expression (bound to type `bool`).
    /// @param whenTrueOperand The lvalue operand for the true branch (its address is taken at emit).
    /// @param whenFalseOperand The lvalue operand for the false branch (its address is taken at emit).
    /// @param pointeeType The common pointee type of the two branches.
    init(
        syntax SyntaxNode?,
        condition BoundExpression,
        whenTrueOperand BoundExpression,
        whenFalseOperand BoundExpression,
        pointeeType TypeSymbol
    ) : base(syntax) {
        Condition = condition
        WhenTrueOperand = whenTrueOperand
        WhenFalseOperand = whenFalseOperand
        PointeeType = pointeeType
        _type = ByRefTypeSymbol.Get(pointeeType)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConditionalAddressExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the bound condition expression (typed `bool`).
    prop Condition BoundExpression {
        get;
    }

    /// Gets the lvalue operand for the true branch.
    prop WhenTrueOperand BoundExpression {
        get;
    }

    /// Gets the lvalue operand for the false branch.
    prop WhenFalseOperand BoundExpression {
        get;
    }

    /// Gets the common pointee type of the two branches.
    prop PointeeType TypeSymbol {
        get;
    }
}
