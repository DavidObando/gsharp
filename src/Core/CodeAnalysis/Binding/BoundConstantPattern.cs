// <copyright file="BoundConstantPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound constant pattern.</summary>
public sealed class BoundConstantPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundConstantPattern"/> class.</summary>
    /// <param name="type">The discriminant type.</param>
    /// <param name="value">The value expression.</param>
    public BoundConstantPattern(TypeSymbol type, BoundExpression value)
        : base(type)
    {
        Value = value;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConstantPattern;

    /// <summary>Gets the value expression.</summary>
    public BoundExpression Value { get; }
}
