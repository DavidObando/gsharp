// <copyright file="BoundPropertyPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound property pattern.</summary>
public sealed class BoundPropertyPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPattern"/> class.</summary>
    /// <param name="type">The discriminant type.</param>
    /// <param name="fields">The field patterns.</param>
    public BoundPropertyPattern(TypeSymbol type, ImmutableArray<BoundPropertyPatternField> fields)
        : base(type)
    {
        Fields = fields;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PropertyPattern;

    /// <summary>Gets the field patterns.</summary>
    public ImmutableArray<BoundPropertyPatternField> Fields { get; }
}
