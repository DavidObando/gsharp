// <copyright file="BoundTupleElementAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Access to a tuple element by 1-based <c>ItemN</c> name (Phase 4.5).
/// </summary>
public sealed class BoundTupleElementAccessExpression : BoundExpression
{
    public BoundTupleElementAccessExpression(BoundExpression receiver, TupleTypeSymbol tupleType, int index)
    {
        Receiver = receiver;
        TupleType = tupleType;
        Index = index;
    }

    public BoundExpression Receiver { get; }

    public TupleTypeSymbol TupleType { get; }

    public int Index { get; }

    public override TypeSymbol Type => TupleType.ElementTypes[Index];

    public override BoundNodeKind Kind => BoundNodeKind.TupleElementAccessExpression;
}
