// <copyright file="BoundManagedReferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

#pragma warning disable CS1591, SA1600

/// <summary>An explicit persistent address, distinct from borrowed address-of.</summary>
public sealed class BoundManagedReferenceExpression : BoundExpression
{
    public BoundManagedReferenceExpression(SyntaxNode? syntax, BoundExpression location, TypeSymbol type, bool readOnly)
        : base(syntax)
    {
        Location = location;
        Type = type;
        IsReadOnly = readOnly;
    }

    public BoundExpression Location { get; }

    public bool IsReadOnly { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ManagedReferenceExpression;
}
