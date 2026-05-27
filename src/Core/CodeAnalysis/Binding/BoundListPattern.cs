// <copyright file="BoundListPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound fixed-length list pattern.</summary>
public sealed class BoundListPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundListPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="elements">The element patterns.</param>
    /// <param name="elementType">The element type.</param>
    public BoundListPattern(SyntaxNode syntax, TypeSymbol type, ImmutableArray<BoundPattern> elements, TypeSymbol elementType)
        : base(syntax, type)
    {
        Elements = elements;
        ElementType = elementType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ListPattern;

    /// <summary>Gets the element patterns.</summary>
    public ImmutableArray<BoundPattern> Elements { get; }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }
}
