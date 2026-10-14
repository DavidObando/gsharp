// <copyright file="SeparatedSyntaxList.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Separated syntax list that includes separators in order to represent
/// expression lists with full fidelity. Useful for IDE-like experiences.
abstract class SeparatedSyntaxList {
    /// Gets the entire list of syntax nodes, including separators.
    /// @returns An immutable array of syntax nodes including separators.
    open func GetWithSeparators() ImmutableArray[SyntaxNode];
}
