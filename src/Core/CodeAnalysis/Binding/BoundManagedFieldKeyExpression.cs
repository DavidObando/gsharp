// <copyright file="BoundManagedFieldKeyExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

#pragma warning disable CS1591, SA1600

/// <summary>Appends a resolved field token to an immutable location key.</summary>
public sealed class BoundManagedFieldKeyExpression : BoundExpression
{
    public BoundManagedFieldKeyExpression(BoundExpression parent, BoundExpression field)
        : base(field.Syntax)
    {
        Parent = parent;
        Field = field;
    }

    public BoundExpression Parent { get; }

    public BoundExpression Field { get; }

    public override TypeSymbol Type => Parent.Type;

    public override BoundNodeKind Kind => BoundNodeKind.ManagedFieldKeyExpression;
}
