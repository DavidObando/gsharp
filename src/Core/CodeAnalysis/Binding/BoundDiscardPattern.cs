#nullable disable

// <copyright file="BoundDiscardPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound discard pattern.</summary>
public sealed class BoundDiscardPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundDiscardPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    public BoundDiscardPattern(SyntaxNode syntax, TypeSymbol type)
        : base(syntax, type)
    {
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.DiscardPattern;
}
