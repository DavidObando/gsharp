// <copyright file="BoundPropertyPatternField.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound property-pattern field.</summary>
public sealed class BoundPropertyPatternField : BoundNode
{
    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="field">The matched field.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, FieldSymbol field, BoundPattern pattern)
        : base(syntax)
    {
        Field = field;
        Pattern = pattern;
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="property">The matched property.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, PropertySymbol property, BoundPattern pattern)
        : base(syntax)
    {
        Property = property;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PropertyPatternField;

    /// <summary>Gets the field symbol.</summary>
    public FieldSymbol Field { get; }

    /// <summary>Gets the matched property symbol, when this member is property-backed.</summary>
    public PropertySymbol Property { get; }

    /// <summary>Gets the matched member type.</summary>
    public TypeSymbol Type => Property?.Type ?? Field.Type;

    /// <summary>Gets the nested field pattern.</summary>
    public BoundPattern Pattern { get; }
}
