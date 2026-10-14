// <copyright file="BoundAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Threading

/// Bound assignment expression.
class BoundAssignmentExpression : BoundExpression {
    private var target BoundExpression?

    /// Initializes a new instance of the (cref:BoundAssignmentExpression) class.
    /// @param syntax The originating syntax.
    /// @param variable The variable symbol.
    /// @param expression The expression.
    /// @param assignedValueType The static type of the right-hand side
    /// value <em>before</em> any conversion to the variable's declared type.
    /// Issue #1123: the statement binder consults this to decide whether an
    /// assignment of a non-nullable value narrows a nullable `var` local
    /// for subsequent reads. `null` falls back to
    /// (cref:Expression)'s (post-conversion) type.
    init(
        syntax SyntaxNode?,
        variable VariableSymbol,
        expression BoundExpression,
        assignedValueType TypeSymbol? = nil
    ) : base(syntax) {
        Variable = variable
        Expression = expression
        AssignedValueType = assignedValueType ?? expression.Type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.AssignmentExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> Expression.Type

    /// Gets the variable symbol.
    prop Variable VariableSymbol {
        get;
    }

    /// Gets the expression.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the assigned variable as an expression — the Roslyn
    /// `IAssignmentOperation.Target` analogue (ADR-0169, issue #4436).
    /// G# stores the target as (cref:Variable), so this is a
    /// (cref:BoundVariableExpression) over it, built on first use for
    /// the analyzer surface; the binder and emitter never read it.
    prop Target BoundExpression {
        get {
            let cached BoundExpression? = Volatile.Read(&target)
            if cached != nil {
                return cached
            }
            // Analyzers may run concurrently: publish the first node built. A
            // node built before the assignment is anchored is not cached, so
            // the target never keeps a missing location.
            let built BoundExpression = BoundVariableExpression(Syntax, Variable)
            if Syntax == nil {
                return built
            }
            return Interlocked.CompareExchange(&target, built, nil) ?? built
        }
    }

    /// Gets the assigned value — the Roslyn `IAssignmentOperation.Value`
    /// analogue; the same node as (cref:Expression).
    prop Value BoundExpression -> Expression

    /// Gets the static type of the right-hand side value before conversion to
    /// the variable's declared type (issue #1123). Used by the statement binder
    /// to drive assignment-based smart-cast narrowing of nullable `var`
    /// locals.
    prop AssignedValueType TypeSymbol {
        get;
    }
}
