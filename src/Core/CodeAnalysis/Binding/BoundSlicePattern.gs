// <copyright file="BoundSlicePattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Issue #1505: a slice ("rest") subpattern inside a (cref:BoundListPattern).
/// It matches the variable-length middle portion of a list pattern. It appears at
/// most once in a list pattern's element vector; the element count before it is the
/// fixed prefix and the count after it is the fixed suffix.
class BoundSlicePattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundSlicePattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type (the enclosing list/array/slice type).
    /// @param elementType The element type of the enclosing list pattern.
    /// @param variable The materialization target: a named capture
    /// (`..rest`) or a synthesized local holding the middle slice; `null`
    /// for a pure discard slice (`..`) with no sub-pattern.
    /// @param pattern The optional sub-pattern matched against the middle
    /// slice value (typed `[]T`), or `null`.
    init(
        syntax SyntaxNode?,
        type TypeSymbol,
        elementType TypeSymbol,
        variable LocalVariableSymbol?,
        pattern BoundPattern?
    ) : base(syntax, type) {
        ElementType = elementType
        Variable = variable
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.SlicePattern

    /// Gets the element type of the enclosing list pattern.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the materialization target local for the middle slice, or `null`
    /// when the slice is a pure discard with no sub-pattern (no materialization).
    prop Variable LocalVariableSymbol? {
        get;
    }

    /// Gets the optional sub-pattern matched against the middle slice, or `null`.
    prop Pattern BoundPattern? {
        get;
    }
}
