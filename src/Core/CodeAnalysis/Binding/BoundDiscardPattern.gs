// <copyright file="BoundDiscardPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound discard pattern.
class BoundDiscardPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundDiscardPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    convenience init(syntax SyntaxNode?, type TypeSymbol) {
        init(syntax, type, nil)
    }

    /// Initializes a new instance of the (cref:BoundDiscardPattern) class with an optional static-type
    /// binding.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param variable The variable introduced by `var name`, or `null` for a discard.
    init(syntax SyntaxNode?, type TypeSymbol, variable LocalVariableSymbol?) : base(syntax, type) {
        Variable = variable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.DiscardPattern

    /// Gets the variable introduced by a total `var name` pattern.
    prop Variable LocalVariableSymbol? {
        get;
    }
}
