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

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PropertyPatternField;

    /// <summary>Gets the field symbol.</summary>
    public FieldSymbol Field { get; }

    /// <summary>Gets the nested field pattern.</summary>
    public BoundPattern Pattern { get; }
}
