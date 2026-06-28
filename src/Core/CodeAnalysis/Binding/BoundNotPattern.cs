#nullable disable

// <copyright file="BoundNotPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound negated pattern (<c>not</c>): matches when the inner pattern does
/// <em>not</em> match.
/// </summary>
public sealed class BoundNotPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundNotPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="pattern">The negated sub-pattern.</param>
    public BoundNotPattern(SyntaxNode syntax, TypeSymbol type, BoundPattern pattern)
        : base(syntax, type)
    {
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.NotPattern;

    /// <summary>Gets the negated sub-pattern.</summary>
    public BoundPattern Pattern { get; }
}
