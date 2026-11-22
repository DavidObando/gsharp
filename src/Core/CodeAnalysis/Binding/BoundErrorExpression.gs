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

    /// Gets or sets the bound receiver of a member access whose member did not bind (GS0158), so
    /// the semantic model still answers the receiver's symbol and type (#6127). The receiver is
    /// not a child of this node: walkers and rewriters do not visit it.
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

    shared {
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

        /// Creates an error expression that retains any failed-call records from [`left`](paramref) and [`right`](paramref).
        internal func WithFailedOperands(left BoundExpression, right BoundExpression? = nil) BoundErrorExpression {
            let error = BoundErrorExpression(nil)
            var builder ImmutableArray[BoundErrorExpression].Builder? = nil
            if left is BoundErrorExpression leftError &&
                (
                !leftError.MemberGroup.IsDefaultOrEmpty ||
                    !leftError.FailedChildren.IsDefaultOrEmpty ||
                    leftError.FailedReceiver != nil
            ) {
                builder ??= ImmutableArray.CreateBuilder[BoundErrorExpression]()
                builder.Add(leftError)
            }
            if right is BoundErrorExpression rightError &&
                (
                !rightError.MemberGroup.IsDefaultOrEmpty ||
                    !rightError.FailedChildren.IsDefaultOrEmpty ||
                    rightError.FailedReceiver != nil
            ) {
                builder ??= ImmutableArray.CreateBuilder[BoundErrorExpression]()
                if !builder.Contains(rightError) {
                    builder.Add(rightError)
                }
            }
            if builder != nil {
                error.FailedChildren = builder.ToImmutable()
            }
            return error
        }
    }
}
