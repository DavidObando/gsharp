// <copyright file="BoundBinaryPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound binary pattern combinator: a conjunction (<c>and</c>) or disjunction
/// (<c>or</c>) of two sub-patterns. For <c>and</c> both sub-patterns must
/// match (left-to-right, right evaluated only if the left matched); for
/// <c>or</c> either sub-pattern matching succeeds (short-circuit).
/// </summary>
public sealed class BoundBinaryPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundBinaryPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="isConjunction"><see langword="true"/> for <c>and</c>; <see langword="false"/> for <c>or</c>.</param>
    /// <param name="left">The left sub-pattern.</param>
    /// <param name="right">The right sub-pattern.</param>
    public BoundBinaryPattern(SyntaxNode syntax, TypeSymbol type, bool isConjunction, BoundPattern left, BoundPattern right)
        : base(syntax, type)
    {
        IsConjunction = isConjunction;
        Left = left;
        Right = right;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BinaryPattern;

    /// <summary>Gets a value indicating whether this is an <c>and</c> (conjunction) pattern.</summary>
    public bool IsConjunction { get; }

    /// <summary>Gets the left sub-pattern.</summary>
    public BoundPattern Left { get; }

    /// <summary>Gets the right sub-pattern.</summary>
    public BoundPattern Right { get; }
}
