// <copyright file="BoundListPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// Bound fixed-length list pattern.
class BoundListPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundListPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param elements The element patterns.
    /// @param elementType The element type.
    /// @param lengthProperty The `Length`/`Count` property for an indexable (non-array) discriminant.
    /// @param indexerProperty The `this[int]` indexer for an indexable (non-array) discriminant.
    /// @param inputVariable The synthesized local the indexable discriminant is spilled to.
    init(
        syntax SyntaxNode?,
        type TypeSymbol,
        elements ImmutableArray[BoundPattern],
        elementType TypeSymbol,
        lengthProperty PropertyInfo? = nil,
        indexerProperty PropertyInfo? = nil,
        inputVariable LocalVariableSymbol? = nil
    ) : base(syntax, type) {
        Elements = elements
        ElementType = elementType
        LengthProperty = lengthProperty
        IndexerProperty = indexerProperty
        InputVariable = inputVariable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ListPattern

    /// Gets the element patterns.
    prop Elements ImmutableArray[BoundPattern] {
        get;
    }

    /// Gets the element type.
    prop ElementType TypeSymbol {
        get;
    }

    /// Gets the `Length`/`Count` property when the discriminant is
    /// an indexable non-array type (issue #3501, e.g. `ImmutableArray[T]`);
    /// `null` for the array/slice form.
    prop LengthProperty PropertyInfo? {
        get;
    }

    /// Gets the `this[int]` indexer for an indexable discriminant.
    prop IndexerProperty PropertyInfo? {
        get;
    }

    /// Gets the synthesized spill local for an indexable discriminant.
    prop InputVariable LocalVariableSymbol? {
        get;
    }
}
