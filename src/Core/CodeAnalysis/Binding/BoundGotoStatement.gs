// <copyright file="BoundGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound goto statement.
class BoundGotoStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundGotoStatement) class.
    /// @param syntax The originating syntax.
    /// @param label The label.
    init(syntax SyntaxNode?, label BoundLabel) : base(syntax) {
        Label = label
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.GotoStatement

    /// Gets the label.
    prop Label BoundLabel {
        get;
    }
}
