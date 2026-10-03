// <copyright file="BoundStructLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// </summary>
public sealed class BoundStructLiteralExpression : BoundExpression
{
    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers)
        : this(syntax, structType, initializers, null)
    {
    }

    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers, BoundExpression? copySource)
        : base(syntax)
    {
        if (copySource != null && (!structType.IsData || !initializers.IsEmpty))
        {
            throw new System.ArgumentException("A copy literal must be a data type without member initializers.", nameof(copySource));
        }

        StructType = structType;
        Initializers = initializers;
        CopySource = copySource;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundFieldInitializer> Initializers { get; }

    /// <summary>
    /// Gets the whole-value copy or class-clone source, when this expression
    /// materializes a native data copy rather than constructing a new value.
    /// </summary>
    public BoundExpression? CopySource { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;

    internal static bool IsStagedConstruction(BoundBlockExpression block)
    {
        if (block.Expression is not BoundStructLiteralExpression { CopySource: null } literal
            || literal.StructType.ClrType != null
            || !literal.StructType.IsData || !literal.StructType.HasPrimaryConstructor
            || block.Statements.Length != literal.Initializers.Length)
        {
            return false;
        }

        for (int i = 0; i < block.Statements.Length; i++)
        {
            if (block.Statements[i] is not BoundVariableDeclaration { Initializer: not null } declaration
                || literal.Initializers[i].Value is not BoundVariableExpression value
                || value.Variable != declaration.Variable)
            {
                return false;
            }
        }

        return true;
    }
}
