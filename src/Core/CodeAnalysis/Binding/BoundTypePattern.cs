// <copyright file="BoundTypePattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound type pattern.</summary>
public sealed class BoundTypePattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundTypePattern"/> class.</summary>
    /// <param name="type">The discriminant type.</param>
    /// <param name="targetType">The target type.</param>
    /// <param name="variable">The introduced variable.</param>
    public BoundTypePattern(TypeSymbol type, TypeSymbol targetType, LocalVariableSymbol variable)
        : base(type)
    {
        TargetType = targetType;
        Variable = variable;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.TypePattern;

    /// <summary>Gets the type tested by this pattern.</summary>
    public TypeSymbol TargetType { get; }

    /// <summary>Gets the variable introduced by this pattern.</summary>
    public LocalVariableSymbol Variable { get; }
}
