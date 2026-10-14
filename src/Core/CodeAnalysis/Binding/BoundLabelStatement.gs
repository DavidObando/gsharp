// <copyright file="BoundLabelStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound label statement.
class BoundLabelStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundLabelStatement) class.
    /// @param syntax The originating syntax.
    /// @param label The label.
    init(syntax SyntaxNode?, label BoundLabel) : base(syntax) {
        Label = label
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.LabelStatement

    /// Gets the label.
    prop Label BoundLabel {
        get;
    }
}
