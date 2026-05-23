// <copyright file="BoundTupleLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A tuple literal expression <c>(e1, e2, ...)</c> bound to a
/// <see cref="TupleTypeSymbol"/>. Element conversions are applied at bind
/// time so the contained <see cref="Elements"/> already match the tuple's
/// element types.
/// </summary>
public sealed class BoundTupleLiteralExpression : BoundExpression
{
    public BoundTupleLiteralExpression(TupleTypeSymbol tupleType, ImmutableArray<BoundExpression> elements)
    {
        TupleType = tupleType;
        Elements = elements;
    }

    public TupleTypeSymbol TupleType { get; }

    public ImmutableArray<BoundExpression> Elements { get; }

    public override TypeSymbol Type => TupleType;

    public override BoundNodeKind Kind => BoundNodeKind.TupleLiteralExpression;
}
