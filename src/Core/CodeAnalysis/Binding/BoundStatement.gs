// <copyright file="BoundStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Statement binding.
abstract class BoundStatement : BoundNode {
    /// Initializes a new instance of the (cref:BoundStatement) class.
    /// @param syntax The originating syntax.
    protected init(syntax SyntaxNode?) : base(syntax) { }
}
