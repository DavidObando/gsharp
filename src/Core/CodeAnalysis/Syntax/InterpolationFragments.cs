// <copyright file="InterpolationFragments.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Reference wrapper for interpolation fragments stored on a syntax token.
/// </summary>
internal sealed class InterpolationFragments
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InterpolationFragments"/> class.
    /// </summary>
    /// <param name="items">The lexer-produced fragments.</param>
    public InterpolationFragments(ImmutableArray<InterpolationFragment> items)
    {
        Items = items;
    }

    /// <summary>Gets the lexer-produced fragments.</summary>
    public ImmutableArray<InterpolationFragment> Items { get; }
}
