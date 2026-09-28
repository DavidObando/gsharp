// <copyright file="GotoNarrowingSnapshot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Collections.ObjectModel;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed class GotoNarrowingSnapshot
{
    private readonly Dictionary<VariableSymbol, TypeSymbol> narrowedVariables;

    public GotoNarrowingSnapshot(
        IReadOnlyDictionary<VariableSymbol, TypeSymbol> narrowedVariables,
        ImmutableArray<FinallyClauseSyntax> activeFinallyClauses)
    {
        this.narrowedVariables = new Dictionary<VariableSymbol, TypeSymbol>(narrowedVariables);
        NarrowedVariables = new ReadOnlyDictionary<VariableSymbol, TypeSymbol>(this.narrowedVariables);
        ActiveFinallyClauses = activeFinallyClauses;
    }

    public IReadOnlyDictionary<VariableSymbol, TypeSymbol> NarrowedVariables { get; }

    public ImmutableArray<FinallyClauseSyntax> ActiveFinallyClauses { get; }

    public GotoNarrowingSnapshot Clone()
        => new(narrowedVariables, ActiveFinallyClauses);

    public void RemoveNarrowing(VariableSymbol variable)
        => narrowedVariables.Remove(variable);

    public void SetNarrowing(VariableSymbol variable, TypeSymbol type)
        => narrowedVariables[variable] = type;
}
