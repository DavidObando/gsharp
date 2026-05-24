// <copyright file="BoundLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound literal expression.
/// </summary>
public sealed class BoundLiteralExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLiteralExpression"/> class.
    /// </summary>
    /// <param name="value">The value.</param>
    public BoundLiteralExpression(object value)
        : this(value, InferType(value))
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLiteralExpression"/> class with an explicit type.
    /// </summary>
    /// <param name="value">The runtime value.</param>
    /// <param name="type">The static type.</param>
    public BoundLiteralExpression(object value, TypeSymbol type)
    {
        Value = value;
        Type = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LiteralExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the value.
    /// </summary>
    public object Value { get; }

    private static TypeSymbol InferType(object value)
    {
        if (value == null)
        {
            return TypeSymbol.Null;
        }

        if (value is bool)
        {
            return TypeSymbol.Bool;
        }

        if (value is int)
        {
            return TypeSymbol.Int;
        }

        if (value is string)
        {
            return TypeSymbol.String;
        }

        throw new Exception($"Unexpected literal '{value}' of type {value.GetType()}");
    }
}
