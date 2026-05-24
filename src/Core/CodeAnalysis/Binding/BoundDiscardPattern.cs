// <copyright file="BoundDiscardPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound discard pattern.</summary>
public sealed class BoundDiscardPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundDiscardPattern"/> class.</summary>
    /// <param name="type">The discriminant type.</param>
    public BoundDiscardPattern(TypeSymbol type)
        : base(type)
    {
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.DiscardPattern;
}
