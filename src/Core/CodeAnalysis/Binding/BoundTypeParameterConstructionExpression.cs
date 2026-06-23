// <copyright file="BoundTypeParameterConstructionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression representing the construction of a type parameter under a
/// <c>new()</c> default-constructor constraint — the G# spelling <c>T()</c>
/// where the enclosing generic declares <c>[T new()]</c> (issue #988).
/// Lowered at emit time to a reified
/// <c>call !!0 System.Activator::CreateInstance&lt;!!T&gt;()</c> (ADR-0087),
/// which produces a real instance for both reference types that expose a public
/// parameterless constructor and value types.
/// </summary>
public sealed class BoundTypeParameterConstructionExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundTypeParameterConstructionExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="typeParameter">The constrained type parameter being constructed.</param>
    public BoundTypeParameterConstructionExpression(SyntaxNode syntax, TypeParameterSymbol typeParameter)
        : base(syntax)
    {
        TypeParameter = typeParameter;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.TypeParameterConstructionExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeParameter;

    /// <summary>Gets the constrained type parameter being constructed.</summary>
    public TypeParameterSymbol TypeParameter { get; }
}
