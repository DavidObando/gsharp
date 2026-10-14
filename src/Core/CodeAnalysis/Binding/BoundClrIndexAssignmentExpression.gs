// <copyright file="BoundClrIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Assigns through a CLR indexer (Phase 4 exit). Example:
/// `d["key"] = 42` where `d` is a `Dictionary[string, int]`.
/// Interpreter-only — the evaluator calls
/// `Indexer.SetValue(target, value, args)`.
/// The target is either a simple variable reference or, after closure-boxing
/// lowering, an arbitrary expression (issue #618).
class BoundClrIndexAssignmentExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        target VariableSymbol,
        indexer PropertyInfo,
        arguments ImmutableArray[BoundExpression],
        value BoundExpression,
        resultType TypeSymbol,
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil
    ) : base(syntax) {
        Target = target
        Indexer = indexer
        Arguments = arguments
        Value = value
        _type = resultType
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
    }

    private init(
        syntax SyntaxNode?,
        targetExpression BoundExpression,
        indexer PropertyInfo,
        arguments ImmutableArray[BoundExpression],
        value BoundExpression,
        resultType TypeSymbol,
        constrainedReceiverTypeParameter TypeParameterSymbol?,
        constrainedInterfaceType TypeSymbol?
    ) : base(syntax) {
        TargetExpression = targetExpression
        Indexer = indexer
        Arguments = arguments
        Value = value
        _type = resultType
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
    }

    prop Target VariableSymbol? {
        get;
    }

    /// Gets the expression-based target, or `null` when the simple
    /// (cref:Target) variable form is used. When non-null, the emitter
    /// evaluates this expression to produce the instance reference instead of
    /// loading (cref:Target).
    prop TargetExpression BoundExpression? {
        get;
    }

    prop Indexer PropertyInfo {
        get;
    }

    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    prop Value BoundExpression {
        get;
    }

    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterAccess bool -> ConstrainedReceiverTypeParameter != nil

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrIndexAssignmentExpression

    shared {
        /// Creates a CLR index assignment with an expression-based target. Used
        /// after closure-boxing lowering when the original target local has been
        /// replaced by a field access through a box (issue #618).
        /// @param syntax The originating syntax, or `null` for synthesized nodes.
        /// @param targetExpression The expression that produces the instance reference.
        /// @param indexer The CLR indexer property.
        /// @param arguments The indexer argument expressions.
        /// @param value The value to assign.
        /// @param resultType The result type of the assignment expression.
        /// @param constrainedReceiverTypeParameter The constrained receiver type parameter, if any.
        /// @param constrainedInterfaceType The imported interface declaring the constrained indexer, if any.
        /// @returns A new (cref:BoundClrIndexAssignmentExpression) with an expression target.
        func WithExpressionTarget(
            syntax SyntaxNode?,
            targetExpression BoundExpression,
            indexer PropertyInfo,
            arguments ImmutableArray[BoundExpression],
            value BoundExpression,
            resultType TypeSymbol,
            constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
            constrainedInterfaceType TypeSymbol? = nil
        ) BoundClrIndexAssignmentExpression {
            return BoundClrIndexAssignmentExpression(
                syntax,
                targetExpression,
                indexer,
                arguments,
                value,
                resultType,
                constrainedReceiverTypeParameter,
                constrainedInterfaceType
            )
        }
    }
}
