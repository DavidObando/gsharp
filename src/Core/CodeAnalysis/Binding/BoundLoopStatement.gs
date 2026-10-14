// <copyright file="BoundLoopStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound loop statement.
abstract class BoundLoopStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundLoopStatement) class.
    /// @param syntax The originating syntax.
    /// @param breakLabel The break label.
    /// @param continueLabel The continue label.
    protected init(syntax SyntaxNode?, breakLabel BoundLabel, continueLabel BoundLabel) : base(syntax) {
        BreakLabel = breakLabel
        ContinueLabel = continueLabel
    }

    /// Gets the break label.
    prop BreakLabel BoundLabel {
        get;
    }

    /// Gets the continue label.
    prop ContinueLabel BoundLabel {
        get;
    }
}
