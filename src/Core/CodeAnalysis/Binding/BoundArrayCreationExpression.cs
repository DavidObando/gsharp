// <copyright file="BoundArrayCreationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound array or slice creation expression — <c>[N]T{e1, e2, …}</c>
/// for arrays and <c>[]T{e1, e2, …}</c> for slices.
/// </summary>
public sealed class BoundArrayCreationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundArrayCreationExpression"/> class.
    /// </summary>
    /// <param name="containerType">The array or slice type symbol.</param>
    /// <param name="elements">The bound element initialisers.</param>
    public BoundArrayCreationExpression(TypeSymbol containerType, ImmutableArray<BoundExpression> elements)
    {
        ContainerType = containerType ?? throw new ArgumentNullException(nameof(containerType));
        Elements = elements;
        ElementType = containerType switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            _ => throw new ArgumentException($"Unsupported container type {containerType.Name} for array/slice creation.", nameof(containerType)),
        };
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ArrayCreationExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ContainerType;

    /// <summary>Gets the array or slice type symbol.</summary>
    public TypeSymbol ContainerType { get; }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>Gets the bound element initialisers.</summary>
    public ImmutableArray<BoundExpression> Elements { get; }
}
