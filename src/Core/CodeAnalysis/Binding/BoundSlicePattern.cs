// <copyright file="BoundSlicePattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #1505: a slice ("rest") subpattern inside a <see cref="BoundListPattern"/>.
/// It matches the variable-length middle portion of a list pattern. It appears at
/// most once in a list pattern's element vector; the element count before it is the
/// fixed prefix and the count after it is the fixed suffix.
/// </summary>
public sealed class BoundSlicePattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundSlicePattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type (the enclosing list/array/slice type).</param>
    /// <param name="elementType">The element type of the enclosing list pattern.</param>
    /// <param name="variable">The materialization target: a named capture
    /// (<c>..rest</c>) or a synthesized local holding the middle slice; <c>null</c>
    /// for a pure discard slice (<c>..</c>) with no sub-pattern.</param>
    /// <param name="pattern">The optional sub-pattern matched against the middle
    /// slice value (typed <c>[]T</c>), or <c>null</c>.</param>
    public BoundSlicePattern(SyntaxNode syntax, TypeSymbol type, TypeSymbol elementType, LocalVariableSymbol variable, BoundPattern pattern)
        : base(syntax, type)
    {
        ElementType = elementType;
        Variable = variable;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SlicePattern;

    /// <summary>Gets the element type of the enclosing list pattern.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets the materialization target local for the middle slice, or <c>null</c>
    /// when the slice is a pure discard with no sub-pattern (no materialization).
    /// </summary>
    public LocalVariableSymbol Variable { get; }

    /// <summary>Gets the optional sub-pattern matched against the middle slice, or <c>null</c>.</summary>
    public BoundPattern Pattern { get; }
}
