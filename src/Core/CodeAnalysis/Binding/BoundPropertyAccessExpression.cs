// <copyright file="BoundPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Represents a read access to a user-defined property (ADR-0051).
/// </summary>
public sealed class BoundPropertyAccessExpression : BoundExpression
{
    public BoundPropertyAccessExpression(SyntaxNode syntax, BoundExpression receiver, StructSymbol structType, PropertySymbol property)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
    }

    public BoundExpression Receiver { get; }

    public StructSymbol StructType { get; }

    public PropertySymbol Property { get; }

    public override TypeSymbol Type => Property.Type;

    public override BoundNodeKind Kind => BoundNodeKind.PropertyAccessExpression;
}
