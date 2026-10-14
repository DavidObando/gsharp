// <copyright file="InterpolationFragments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Reference wrapper for interpolation fragments stored on a syntax token.
internal class InterpolationFragments {
    /// Initializes a new instance of the (cref:InterpolationFragments) class.
    /// @param items The lexer-produced fragments.
    init(items ImmutableArray[InterpolationFragment]) {
        Items = items
    }

    /// Gets the lexer-produced fragments.
    prop Items ImmutableArray[InterpolationFragment] {
        get;
    }
}
