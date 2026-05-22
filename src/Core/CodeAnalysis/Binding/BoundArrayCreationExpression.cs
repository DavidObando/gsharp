// <copyright file="BoundArrayCreationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound array creation expression <c>[N]T{e1, e2, …}</c>.
/// </summary>
public sealed class BoundArrayCreationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundArrayCreationExpression"/> class.
    /// </summary>
    /// <param name="arrayType">The array type symbol.</param>
    /// <param name="elements">The bound element initialisers.</param>
    public BoundArrayCreationExpression(ArrayTypeSymbol arrayType, ImmutableArray<BoundExpression> elements)
    {
        ArrayType = arrayType;
        Elements = elements;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ArrayCreationExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ArrayType;

    /// <summary>Gets the array type symbol.</summary>
    public ArrayTypeSymbol ArrayType { get; }

    /// <summary>Gets the bound element initialisers.</summary>
    public ImmutableArray<BoundExpression> Elements { get; }
}
