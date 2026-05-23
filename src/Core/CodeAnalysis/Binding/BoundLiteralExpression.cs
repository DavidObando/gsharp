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
    {
        Value = value;

        if (value == null)
        {
            // Phase 3.C.2 / ADR-0001: the nil literal carries the special
            // TypeSymbol.Null sentinel until conversion or smart-cast pins it
            // to a concrete nullable type.
            Type = TypeSymbol.Null;
        }
        else if (value is bool)
        {
            Type = TypeSymbol.Bool;
        }
        else if (value is int)
        {
            Type = TypeSymbol.Int;
        }
        else if (value is string)
        {
            Type = TypeSymbol.String;
        }
        else
        {
            throw new Exception($"Unexpected literal '{value}' of type {value.GetType()}");
        }
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LiteralExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the value.
    /// </summary>
    public object Value { get; }
}
