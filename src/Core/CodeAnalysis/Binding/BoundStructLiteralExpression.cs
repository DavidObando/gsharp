// <copyright file="BoundStructLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// </summary>
public sealed class BoundStructLiteralExpression : BoundExpression
{
    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers, BoundExpression? copySource = null)
        : base(syntax)
    {
        if (copySource != null && (!structType.IsClass || !structType.IsData || !initializers.IsEmpty))
        {
            throw new System.ArgumentException("A clone literal must be a data class without member initializers.", nameof(copySource));
        }

        StructType = structType;
        Initializers = initializers;
        CopySource = copySource;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundFieldInitializer> Initializers { get; }

    /// <summary>Gets the captured source for a data-class clone; null for ordinary construction.</summary>
    public BoundExpression? CopySource { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;
}
