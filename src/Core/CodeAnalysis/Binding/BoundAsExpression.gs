// <copyright file="BoundAsExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression-level safe cast: `expr as T` → `T` (reference) or `T?` (value).
/// Issue #575.
class BoundAsExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundAsExpression) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression being cast.
    /// @param targetType The target type (already includes nullable wrapping if needed).
    init(syntax SyntaxNode?, expression BoundExpression, targetType TypeSymbol) : base(syntax) {
        Expression = expression
        TargetType = targetType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.AsExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TargetType

    /// Gets the expression being cast.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the result type of the safe cast.
    prop TargetType TypeSymbol {
        get;
    }
}
