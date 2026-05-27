// <copyright file="BoundTupleLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

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
    public BoundTupleLiteralExpression(SyntaxNode syntax, TupleTypeSymbol tupleType, ImmutableArray<BoundExpression> elements)
        : base(syntax)
    {
        TupleType = tupleType;
        Elements = elements;
    }

    public TupleTypeSymbol TupleType { get; }

    public ImmutableArray<BoundExpression> Elements { get; }

    public override TypeSymbol Type => TupleType;

    public override BoundNodeKind Kind => BoundNodeKind.TupleLiteralExpression;
}
