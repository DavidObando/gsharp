// <copyright file="BoundRelationalPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound relational pattern.</summary>
public sealed class BoundRelationalPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundRelationalPattern"/> class.</summary>
    /// <param name="type">The discriminant type.</param>
    /// <param name="op">The operator.</param>
    /// <param name="value">The right-hand value.</param>
    public BoundRelationalPattern(TypeSymbol type, BoundBinaryOperator op, BoundExpression value)
        : base(type)
    {
        Op = op;
        Value = value;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.RelationalPattern;

    /// <summary>Gets the relational operator.</summary>
    public BoundBinaryOperator Op { get; }

    /// <summary>Gets the right-hand value expression.</summary>
    public BoundExpression Value { get; }
}
