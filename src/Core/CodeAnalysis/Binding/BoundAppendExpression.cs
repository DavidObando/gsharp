// <copyright file="BoundAppendExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound built-in <c>append(slice, element)</c> expression. Returns a
/// new slice that contains the original elements followed by the
/// appended one. Phase 3.A.2 supports a single trailing element only;
/// Go's variadic <c>append(s, e1, e2, …)</c> arrives in Phase 4.
/// </summary>
public sealed class BoundAppendExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAppendExpression"/> class.
    /// </summary>
    /// <param name="slice">The slice operand.</param>
    /// <param name="element">The element to append.</param>
    /// <param name="sliceType">The slice type symbol that is also the expression type.</param>
    public BoundAppendExpression(BoundExpression slice, BoundExpression element, SliceTypeSymbol sliceType)
    {
        Slice = slice;
        Element = element;
        SliceType = sliceType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AppendExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => SliceType;

    /// <summary>Gets the slice operand.</summary>
    public BoundExpression Slice { get; }

    /// <summary>Gets the element being appended.</summary>
    public BoundExpression Element { get; }

    /// <summary>Gets the slice type symbol.</summary>
    public SliceTypeSymbol SliceType { get; }
}
