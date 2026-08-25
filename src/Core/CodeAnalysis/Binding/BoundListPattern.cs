// <copyright file="BoundListPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound fixed-length list pattern.</summary>
public sealed class BoundListPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundListPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="elements">The element patterns.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="lengthProperty">The <c>Length</c>/<c>Count</c> property for an indexable (non-array) discriminant.</param>
    /// <param name="indexerProperty">The <c>this[int]</c> indexer for an indexable (non-array) discriminant.</param>
    /// <param name="inputVariable">The synthesized local the indexable discriminant is spilled to.</param>
    public BoundListPattern(
        SyntaxNode? syntax,
        TypeSymbol type,
        ImmutableArray<BoundPattern> elements,
        TypeSymbol elementType,
        PropertyInfo? lengthProperty = null,
        PropertyInfo? indexerProperty = null,
        LocalVariableSymbol? inputVariable = null)
        : base(syntax, type)
    {
        Elements = elements;
        ElementType = elementType;
        LengthProperty = lengthProperty;
        IndexerProperty = indexerProperty;
        InputVariable = inputVariable;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ListPattern;

    /// <summary>Gets the element patterns.</summary>
    public ImmutableArray<BoundPattern> Elements { get; }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets the <c>Length</c>/<c>Count</c> property when the discriminant is
    /// an indexable non-array type (issue #3501, e.g. <c>ImmutableArray[T]</c>);
    /// <c>null</c> for the array/slice form.
    /// </summary>
    public PropertyInfo? LengthProperty { get; }

    /// <summary>Gets the <c>this[int]</c> indexer for an indexable discriminant.</summary>
    public PropertyInfo? IndexerProperty { get; }

    /// <summary>Gets the synthesized spill local for an indexable discriminant.</summary>
    public LocalVariableSymbol? InputVariable { get; }
}
