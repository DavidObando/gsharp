// <copyright file="ManagedReferenceArrayNullableState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable annotations

using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

internal sealed class ManagedReferenceArrayNullableState
{
    // Effective type of conditional/switch expressions whose arms carry
    // managed-reference projection. Null values cache no common safe type.
    public Dictionary<ExpressionSyntax, ITypeSymbol?>
        ManagedReferenceArrayProjectedCompositeType { get; } =
            new Dictionary<ExpressionSyntax, ITypeSymbol?>(
                ReferenceEqualityComparer.Instance);

    // Keyed by the Roslyn element type; outer array nullability does not affect
    // CSharpTypeMapper's recursively projected element shape.
    public Dictionary<ITypeSymbol, GTypeReference?> MappedArrayElementByElementType { get; } =
        new Dictionary<ITypeSymbol, GTypeReference?>(SymbolEqualityComparer.IncludeNullability);

    // Per-call effective method after managed-array projection. A null value
    // caches that the invocation or construction needs no substitution.
    public Dictionary<ExpressionSyntax, IMethodSymbol?>
        ManagedReferenceArrayProjectedMethodByCall { get; } =
            new Dictionary<ExpressionSyntax, IMethodSymbol?>(
                ReferenceEqualityComparer.Instance);

    // Effective emitted type of a local whose initializer, assignments, or
    // active foreach binding agree on managed-reference projection.
    public Dictionary<ILocalSymbol, ITypeSymbol?> ManagedReferenceArrayProjectedLocalType { get; } =
        new Dictionary<ILocalSymbol, ITypeSymbol?>(SymbolEqualityComparer.Default);
}

internal sealed class NullableTypeSymbolSlots
{
    private readonly ITypeSymbol?[] values;

    public NullableTypeSymbolSlots(int length)
    {
        this.values = new ITypeSymbol?[length];
    }

    public int Length => this.values.Length;

    public bool HasAnyValue
    {
        get
        {
            foreach (ITypeSymbol? value in this.values)
            {
                if (value != null)
                {
                    return true;
                }
            }

            return false;
        }
    }

    public ITypeSymbol? this[int index]
    {
        get => this.values[index];
        set => this.values[index] = value;
    }
}
