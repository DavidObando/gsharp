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
    public BoundStructLiteralExpression(SyntaxNode syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers)
        : base(syntax)
    {
        StructType = structType;
        Initializers = initializers;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundFieldInitializer> Initializers { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;
}
