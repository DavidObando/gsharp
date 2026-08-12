// <copyright file="BoundIndexExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

#pragma warning disable SA1611
#pragma warning disable SA1642

/// <summary>
/// Bound index expression <c>target[index]</c>.
/// </summary>
public sealed class BoundIndexExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundIndexExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="target">The target expression (must have an array type).</param>
    /// <param name="index">The index expression (must be int).</param>
    /// <param name="resultType">The element type.</param>
    public BoundIndexExpression(SyntaxNode? syntax, BoundExpression target, BoundExpression index, TypeSymbol resultType)
        : this(syntax, target, ImmutableArray.Create(index), resultType)
    {
    }

    #pragma warning restore SA1642
    #pragma warning restore SA1611

    /// <summary>Initializes a new instance of the <see cref="BoundIndexExpression"/> class.</summary>
    /// <param name="syntax">Originating syntax.</param>
    /// <param name="target">Indexed target.</param>
    /// <param name="indices">Index expressions.</param>
    /// <param name="resultType">Element type.</param>
    public BoundIndexExpression(
        SyntaxNode? syntax,
        BoundExpression target,
        ImmutableArray<BoundExpression> indices,
        TypeSymbol resultType)
        : base(syntax)
    {
        Target = target;
        Indices = indices;
        Type = resultType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IndexExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the target expression.</summary>
    public BoundExpression Target { get; }

    /// <summary>Gets the index expression.</summary>
    public BoundExpression Index => Indices[0];

    /// <summary>Gets index expressions.</summary>
    public ImmutableArray<BoundExpression> Indices { get; }

    /// <summary>
    /// Gets a value indicating whether this element load reads real,
    /// addressable array storage (issue #3292). Fixed arrays (<c>[N]T</c>),
    /// slices (<c>[]T</c>, ADR-0016: CLR-array-backed), and imported CLR
    /// single-dimensional arrays all store their elements in a heap array
    /// whose element address is expressible in IL (<c>ldelema</c>), so a
    /// struct member write through the element can mutate it in place. Map
    /// elements (<see cref="MapTypeSymbol"/> — the Dictionary indexer
    /// returns a copy) and string elements (<c>get_Chars</c>) have no
    /// element address and stay non-addressable.
    /// </summary>
    public bool IsArrayBackedElementAccess =>
        Target.Type is ArrayTypeSymbol or SliceTypeSymbol or RectangularArrayTypeSymbol
        || (Target.Type is not MapTypeSymbol
            && Target.Type != TypeSymbol.String
            && Target.Type?.ClrType is { IsArray: true } clrArray
            && clrArray.GetArrayRank() == 1);
}
