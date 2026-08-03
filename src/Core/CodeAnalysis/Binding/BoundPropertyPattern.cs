// <copyright file="BoundPropertyPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound property pattern.</summary>
public sealed class BoundPropertyPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="fields">The field patterns.</param>
    public BoundPropertyPattern(SyntaxNode syntax, TypeSymbol type, ImmutableArray<BoundPropertyPatternField> fields)
        : base(syntax, type)
    {
        Fields = fields;
        InputVariable = new LocalVariableSymbol("<property-pattern-input>", isReadOnly: true, type);
        if (type is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable))
        {
            UnwrappedVariable = new LocalVariableSymbol("<property-pattern-value>", isReadOnly: true, nullable.UnderlyingType);
        }
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PropertyPattern;

    /// <summary>Gets the field patterns.</summary>
    public ImmutableArray<BoundPropertyPatternField> Fields { get; }

    /// <summary>Gets the temporary holding the pattern input exactly once.</summary>
    public LocalVariableSymbol InputVariable { get; }

    /// <summary>Gets the unwrapped nullable value-type temporary, when required.</summary>
    public LocalVariableSymbol UnwrappedVariable { get; }
}
