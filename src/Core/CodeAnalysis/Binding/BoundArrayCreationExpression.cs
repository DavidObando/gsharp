// <copyright file="BoundArrayCreationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

#pragma warning disable SA1201
#pragma warning disable SA1611
#pragma warning disable SA1615
#pragma warning disable SA1642

/// <summary>
/// Bound array or slice creation expression — <c>[N]T{e1, e2, …}</c>
/// for arrays and <c>[]T{e1, e2, …}</c> for slices.
/// </summary>
public sealed class BoundArrayCreationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundArrayCreationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="containerType">The array or slice type symbol.</param>
    /// <param name="elements">The bound element initialisers.</param>
    public BoundArrayCreationExpression(SyntaxNode? syntax, TypeSymbol containerType, ImmutableArray<BoundExpression> elements)
        : base(syntax)
    {
        ContainerType = containerType ?? throw new ArgumentNullException(nameof(containerType));
        Elements = elements;
        ElementType = containerType switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            RectangularArrayTypeSymbol rectangular => rectangular.ElementType,
            _ => throw new ArgumentException($"Unsupported container type {containerType.Name} for array/slice creation.", nameof(containerType)),
        };
    }

    #pragma warning restore SA1642
    #pragma warning restore SA1615
    #pragma warning restore SA1611
    #pragma warning restore SA1201

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundArrayCreationExpression"/>
    /// class for a zero-initialised array/slice of a runtime-computed length
    /// (issue #1016 slicing). The result is an array of <paramref name="lengthExpression"/>
    /// default-valued elements; no element initialisers are supplied.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="containerType">The array or slice type symbol.</param>
    /// <param name="lengthExpression">The runtime length expression (int32).</param>
    public BoundArrayCreationExpression(SyntaxNode? syntax, TypeSymbol containerType, BoundExpression lengthExpression)
        : this(
            syntax,
            containerType,
            ImmutableArray.Create(lengthExpression),
            ImmutableArray<BoundExpression>.Empty,
            ImmutableArray<int>.Empty)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundArrayCreationExpression"/> class.</summary>
    private BoundArrayCreationExpression(
        SyntaxNode? syntax,
        TypeSymbol containerType,
        ImmutableArray<BoundExpression> dimensionExpressions,
        ImmutableArray<BoundExpression> elements,
        ImmutableArray<int> rectangularLengths)
        : base(syntax)
    {
        ContainerType = containerType ?? throw new ArgumentNullException(nameof(containerType));
        Elements = elements;
        DimensionExpressions = dimensionExpressions;
        RectangularLengths = rectangularLengths;
        LengthExpression = dimensionExpressions.IsDefaultOrEmpty ? null : dimensionExpressions[0];
        ElementType = containerType switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            RectangularArrayTypeSymbol rectangular => rectangular.ElementType,
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

    /// <summary>
    /// Gets the runtime length expression for a zero-initialised array/slice
    /// (issue #1016 slicing), or <see langword="null"/> when the array is built
    /// from explicit <see cref="Elements"/> initialisers.
    /// </summary>
    public BoundExpression? LengthExpression { get; }

    /// <summary>Gets the bound element initialisers.</summary>
    public ImmutableArray<BoundExpression> Elements { get; }

    /// <summary>Gets runtime dimensions in evaluation order.</summary>
    public ImmutableArray<BoundExpression> DimensionExpressions { get; } = ImmutableArray<BoundExpression>.Empty;

    /// <summary>Gets constant dimensions used to map flat initializer elements.</summary>
    public ImmutableArray<int> RectangularLengths { get; } = ImmutableArray<int>.Empty;

    /// <summary>Creates a runtime-sized rectangular-array allocation.</summary>
    /// <param name="syntax">Originating syntax.</param>
    /// <param name="containerType">Rectangular array type.</param>
    /// <param name="dimensionExpressions">Bound dimensions.</param>
    /// <param name="elements">Flat row-major initializer elements.</param>
    /// <param name="rectangularLengths">Constant dimensions for initializer mapping.</param>
    /// <returns>Bound rectangular allocation.</returns>
    public static BoundArrayCreationExpression CreateRectangular(
        SyntaxNode? syntax,
        RectangularArrayTypeSymbol containerType,
        ImmutableArray<BoundExpression> dimensionExpressions,
        ImmutableArray<BoundExpression> elements = default,
        ImmutableArray<int> rectangularLengths = default)
        => new(
            syntax,
            containerType,
            dimensionExpressions,
            elements.IsDefault ? ImmutableArray<BoundExpression>.Empty : elements,
            rectangularLengths.IsDefault ? ImmutableArray<int>.Empty : rectangularLengths);
}
