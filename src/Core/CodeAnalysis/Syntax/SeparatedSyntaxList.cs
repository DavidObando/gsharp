// <copyright file="SeparatedSyntaxList.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Separated syntax list that includes separators in order to represent
/// expression lists with full fidelity. Useful for IDE-like experiences.
/// </summary>
public abstract class SeparatedSyntaxList
{
    /// <summary>
    /// Gets the entire list of syntax nodes, including separators.
    /// </summary>
    /// <returns>An immutable array of syntax nodes including separators.</returns>
    public abstract ImmutableArray<SyntaxNode> GetWithSeparators();
}
