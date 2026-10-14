// <copyright file="BoundPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Base class for bound switch patterns.
abstract class BoundPattern : BoundNode {
    /// Initializes a new instance of the (cref:BoundPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    protected init(syntax SyntaxNode?, type TypeSymbol) : base(syntax) {
        Type = type
    }

    /// Gets the discriminant type the pattern was bound against.
    prop Type TypeSymbol {
        get;
    }
}
