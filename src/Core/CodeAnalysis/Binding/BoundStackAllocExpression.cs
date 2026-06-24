// <copyright file="BoundStackAllocExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0124 / issue #1024: a bound stack-allocation expression
/// <c>stackalloc T[n]</c>. Lowers to a CIL <c>localloc</c> over
/// <c>n * sizeof(T)</c> bytes. The result is either a
/// <c>System.Span&lt;T&gt;</c> constructed over the allocated memory (the
/// safe form, <see cref="IsPointerForm"/> = <see langword="false"/>) or the
/// raw <c>T*</c> pointer to that memory (the unsafe form,
/// <see cref="IsPointerForm"/> = <see langword="true"/>, only produced inside
/// an <c>unsafe</c> context with an unmanaged-pointer target type).
/// </summary>
public sealed class BoundStackAllocExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundStackAllocExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="resultType">The result type (<c>Span&lt;T&gt;</c> or <c>T*</c>).</param>
    /// <param name="elementType">The blittable element type <c>T</c>.</param>
    /// <param name="count">The element-count expression (int32).</param>
    /// <param name="isPointerForm">Whether the result is the raw <c>T*</c> pointer.</param>
    public BoundStackAllocExpression(
        SyntaxNode syntax,
        TypeSymbol resultType,
        TypeSymbol elementType,
        BoundExpression count,
        bool isPointerForm)
        : base(syntax)
    {
        ResultType = resultType ?? throw new ArgumentNullException(nameof(resultType));
        ElementType = elementType ?? throw new ArgumentNullException(nameof(elementType));
        Count = count ?? throw new ArgumentNullException(nameof(count));
        IsPointerForm = isPointerForm;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.StackAllocExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ResultType;

    /// <summary>Gets the result type (<c>Span&lt;T&gt;</c> or <c>T*</c>).</summary>
    public TypeSymbol ResultType { get; }

    /// <summary>Gets the blittable element type <c>T</c>.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>Gets the element-count expression (int32).</summary>
    public BoundExpression Count { get; }

    /// <summary>Gets a value indicating whether the result is the raw <c>T*</c> pointer (unsafe form).</summary>
    public bool IsPointerForm { get; }
}
