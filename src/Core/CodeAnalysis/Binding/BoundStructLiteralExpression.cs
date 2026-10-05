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
        : this(syntax, structType, initializers, copySource: null)
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

    /// <summary>Gets the captured source for a data-class clone or value copy; null for fresh construction.</summary>
    public BoundExpression? CopySource { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;

    internal ImmutableArray<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)> GetPrimaryConstructorArguments()
    {
        // Imported positional literals already carry their CLR constructor's
        // property arguments; they do not have compiler-owned storage fields.
        if (StructType.ClrType != null)
        {
            return ImmutableArray<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)>.Empty;
        }

        var arguments = ImmutableArray.CreateBuilder<(FieldSymbol Field, BoundExpression Value, bool IsSupplied)>(
            StructType.PrimaryConstructorParameters.Length);
        foreach (var parameter in StructType.PrimaryConstructorParameters)
        {
            ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(StructType, parameter.Name, out var field);
            var storage = Invariant.Required(field, "primary constructor parameters have corresponding fields");
            var initializer = Initializers.FirstOrDefault(
                candidate => candidate.Field == storage || candidate.Property?.BackingField == storage);
            arguments.Add((storage, initializer?.Value ?? new BoundDefaultExpression(Syntax, storage.Type), initializer != null));
        }

        return arguments.MoveToImmutable();
    }
}
