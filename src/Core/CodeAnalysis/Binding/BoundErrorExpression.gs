// <copyright file="BoundErrorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound error expression.
class BoundErrorExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundErrorExpression) class.
    /// @param syntax The originating syntax (may be `null` for synthesised nodes).
    init(syntax SyntaxNode?) : base(syntax) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ErrorExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Error

    /// Gets the call syntax node whose failed bind produced this error (ADR-0212 issue #5444).
    internal prop CallSyntax SyntaxNode? {
        get;
        set;
    }

    /// Gets the candidates overload resolution considered before the call failed (ADR-0212 issue #5444).
    internal prop MemberGroup ImmutableArray[object] {
        get;
        set;
    }

    /// Gets the receiver type of the failed call, when any (ADR-0212 issue #5444).
    internal prop ReceiverType TypeSymbol? {
        get;
        set;
    }

    /// Gets whether the failed call resolved among source extension functions (ADR-0212 issue #5444).
    internal prop IsExtensionCall bool {
        get;
        set;
    }

    /// Gets any inner failed calls whose error nodes were discarded when an outer call failed.
    internal prop FailedChildren ImmutableArray[BoundErrorExpression] {
        get;
        set;
    }

    /// Gets or sets the bound receiver of a member access whose member did not bind (GS0158), or of
    /// a call that did not bind (GS0159 and every other failed call, #6151), so the semantic model
    /// still answers the receiver's symbol and type (#6127). The receiver is not a child of this
    /// node: walkers and rewriters do not visit it.
    internal prop FailedReceiver BoundExpression? {
        get;
        set;
    }

    /// Gets or sets the syntax of (cref:FailedReceiver) when the binder built the receiver from a
    /// token or an expression it did not anchor (the `c` of a failed write `c.N = 1`).
    internal prop FailedReceiverSyntax SyntaxNode? {
        get;
        set;
    }

    /// Gets or sets the bound arguments of a call that did not bind (and the member values of an
    /// object initializer on a constructor call that did not bind), so the semantic model still
    /// answers their symbols and types (#6150). An argument the binder never bound (a function
    /// literal waiting for a target type) is absent. The arguments are not children of this node:
    /// walkers and rewriters do not visit them.
    internal prop FailedArguments ImmutableArray[BoundExpression] {
        get;
        set;
    }

    /// Gets or sets the operands of an operator expression that did not bind, when the operands
    /// are not failed calls, so the semantic model still answers their symbols and types (#6187).
    /// For a compound assignment, they include the target read and the receiver and index values
    /// that the binder saved in temporaries. The operands are not children of this node: walkers
    /// and rewriters do not visit them.
    internal prop FailedOperands ImmutableArray[BoundExpression] {
        get;
        set;
    }

    /// Gets or sets the bound callee of a call through a function value that did not bind (`f(x, 2)`
    /// with `f` a local, a parameter, a field or a property of function or delegate type), anchored
    /// at the callee's identifier, so the semantic model answers the callee as in a call that binds
    /// (#6189). The callee is not a child of this node: walkers and rewriters do not visit it.
    internal prop FailedCallee BoundExpression? {
        get;
        set;
    }

    /// Gets whether this error keeps a record the semantic model reads: a candidate group, an
    /// inner failed call, a failed receiver, failed arguments, a failed callee or failed operands.
    internal prop HasFailedRecords bool -> !MemberGroup.IsDefaultOrEmpty ||
        !FailedChildren.IsDefaultOrEmpty ||
        FailedReceiver != nil ||
        !FailedArguments.IsDefaultOrEmpty ||
        FailedCallee != nil ||
        !FailedOperands.IsDefaultOrEmpty

    /// Keeps the operands of the operator expression that this error replaces, for the semantic
    /// model only (#6187). An operand that is an error gives its failed-call records. Any other
    /// operand, a wrapper around a failed call included, is kept as a failed operand.
    /// @param left The bound left (or only) operand.
    /// @param right The bound right operand, or null.
    internal func KeepOperands(left BoundExpression, right BoundExpression? = nil) {
        KeepOperand(left)
        if right != nil {
            KeepOperand(right)
        }
    }

    private func KeepOperand(operand BoundExpression) {
        if object.ReferenceEquals(operand, this) {
            return
        }
        // A wrapper around a failed call (a block that saves a receiver, a conversion) is kept
        // whole: the index reaches the failed call through it, and also the values it saves.
        if operand is BoundErrorExpression operandError {
            if operandError.HasFailedRecords && (FailedChildren.IsDefault || !FailedChildren.Contains(operandError)) {
                FailedChildren = if FailedChildren.IsDefault {
                    ImmutableArray.Create(operandError)
                } else {
                    FailedChildren.Add(operandError)
                }
            }
        } else if FailedOperands.IsDefault {
            FailedOperands = ImmutableArray.Create(operand)
        } else if !FailedOperands.Contains(operand) {
            FailedOperands = FailedOperands.Add(operand)
        }
    }

    shared {
        /// Finds the error of a failed call through the wrappers a call bind can put around it: a
        /// block that saves a native-slice receiver, a conversion, a suspending call's logical
        /// operand.
        /// @param bound The bound expression.
        /// @returns The error, or null when [`bound`](paramref) is not a failed call.
        internal func FindFailedCall(bound BoundExpression) BoundErrorExpression? {
            var node BoundExpression? = bound
            for var depth = 0; depth < 8 && node != nil; depth++ {
                if node is BoundErrorExpression error {
                    return error
                }
                node = switch node {
                    case logical is BoundExpression{LogicalCompletionOperand: {} operand}: operand
                    case block is BoundBlockExpression: block.Expression
                    case conversion is BoundConversionExpression: conversion.Expression
                    default: default(BoundExpression?)
                }
            }
            return nil
        }

        /// Creates the error of a member access whose member did not bind, keeping its receiver.
        /// @param receiver The bound receiver, or null.
        /// @param receiverSyntax The receiver's syntax, when the receiver does not carry it.
        /// @returns The error expression.
        internal func ForFailedMemberAccess(
            receiver BoundExpression?,
            receiverSyntax SyntaxNode? = nil
        ) BoundErrorExpression {
            let error = BoundErrorExpression(nil)
            if receiver != nil && !(receiver is BoundErrorExpression) {
                error.FailedReceiver = receiver
                error.FailedReceiverSyntax = receiverSyntax
            }
            return error
        }

        /// Creates the error of an operator expression that did not bind. It keeps the failed-call
        /// records of the operands that are errors and the operands that are not (#6187).
        /// @param left The bound left (or only) operand.
        /// @param right The bound right operand, or null.
        /// @returns The error expression.
        internal func WithFailedOperands(left BoundExpression, right BoundExpression? = nil) BoundErrorExpression {
            let error = BoundErrorExpression(nil)
            error.KeepOperands(left, right)
            return error
        }
    }
}
