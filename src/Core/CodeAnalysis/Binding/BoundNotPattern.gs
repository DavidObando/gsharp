// <copyright file="BoundNotPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound negated pattern (`not`): matches when the inner pattern does
/// <em>not</em> match.
class BoundNotPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundNotPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param pattern The negated sub-pattern.
    init(syntax SyntaxNode?, type TypeSymbol, pattern BoundPattern) : base(syntax, type) {
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.NotPattern

    /// Gets the negated sub-pattern.
    prop Pattern BoundPattern {
        get;
    }
}
