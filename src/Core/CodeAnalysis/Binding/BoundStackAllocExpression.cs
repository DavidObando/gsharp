#nullable disable

// <copyright file="BoundStackAllocExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0124 / issues #1024, #1057, #1041: a bound stack-allocation expression
/// in G#-style array grammar <c>stackalloc [n]T</c>. Lowers to a CIL
/// <c>localloc</c> over <c>n * sizeof(T)</c> bytes. The result is either a
/// <c>System.Span&lt;T&gt;</c> constructed over the allocated memory (the
/// safe form, <see cref="IsPointerForm"/> = <see langword="false"/>) or the
/// raw <c>T*</c> pointer to that memory (the unsafe form,
/// <see cref="IsPointerForm"/> = <see langword="true"/>, only produced inside
/// an <c>unsafe</c> context with an unmanaged-pointer target type).
/// <para>
/// When an initializer is present (<c>stackalloc [n]T{a, b, …}</c> or the
/// count-inferred <c>stackalloc []T{a, b, …}</c>), <see cref="Count"/> is the
/// initializer length and <see cref="InitializerElements"/> carries the
/// (element-typed, conversion-bound) values that are stored into the block via
/// scaled indirect writes (issue #1041).
/// </para>
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
    /// <param name="initializerElements">The initializer element values, or empty when there is no initializer.</param>
    public BoundStackAllocExpression(
        SyntaxNode syntax,
        TypeSymbol resultType,
        TypeSymbol elementType,
        BoundExpression count,
        bool isPointerForm,
        ImmutableArray<BoundExpression> initializerElements = default)
        : base(syntax)
    {
        ResultType = resultType ?? throw new ArgumentNullException(nameof(resultType));
        ElementType = elementType ?? throw new ArgumentNullException(nameof(elementType));
        Count = count ?? throw new ArgumentNullException(nameof(count));
        IsPointerForm = isPointerForm;
        InitializerElements = initializerElements.IsDefault ? ImmutableArray<BoundExpression>.Empty : initializerElements;
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

    /// <summary>Gets the initializer element values, or empty when there is no initializer (issue #1041).</summary>
    public ImmutableArray<BoundExpression> InitializerElements { get; }

    /// <summary>Gets a value indicating whether an initializer is present.</summary>
    public bool HasInitializer => !InitializerElements.IsDefaultOrEmpty;
}
