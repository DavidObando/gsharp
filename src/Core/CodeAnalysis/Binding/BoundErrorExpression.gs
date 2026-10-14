// <copyright file="BoundErrorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

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
}
