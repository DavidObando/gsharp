// <copyright file="BoundFieldInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A single <c>FieldName: value</c> initializer inside a struct composite literal.
/// </summary>
public sealed class BoundFieldInitializer
{
    public BoundFieldInitializer(FieldSymbol field, BoundExpression value)
    {
        Field = field;
        Value = value;
    }

    public FieldSymbol Field { get; }

    public BoundExpression Value { get; }
}
