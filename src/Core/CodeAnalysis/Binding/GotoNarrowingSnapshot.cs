// <copyright file="GotoNarrowingSnapshot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Collections.ObjectModel;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

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

internal sealed class BackwardGotoNarrowingState
{
    public BackwardGotoNarrowingState(
        GotoNarrowingSnapshot targetSnapshot,
        int targetAssignmentGeneration)
    {
        TargetSnapshot = targetSnapshot;
        TargetAssignmentGeneration = targetAssignmentGeneration;
    }

    public GotoNarrowingSnapshot TargetSnapshot { get; }

    public int TargetAssignmentGeneration { get; }

    public List<BackwardGotoNarrowingAccess> Accesses { get; } = new();

    public List<BackwardGotoNarrowingEdge> Edges { get; } = new();

    public BackwardGotoNarrowingState Clone()
    {
        var clone = new BackwardGotoNarrowingState(
            TargetSnapshot.Clone(),
            TargetAssignmentGeneration);
        clone.Accesses.AddRange(Accesses);
        foreach (var edge in Edges)
        {
            clone.Edges.Add(edge.Copy());
        }

        return clone;
    }
}

internal sealed record BackwardGotoNarrowingAccess(
    VariableSymbol Variable,
    TextLocation Location,
    string MemberName,
    bool IsInvocation);

internal sealed record BackwardGotoNarrowingEdge(
    GotoNarrowingSnapshot SourceSnapshot,
    ImmutableArray<BackwardGotoNarrowingAccess> Accesses)
{
    public BackwardGotoNarrowingEdge Copy()
        => new(SourceSnapshot.Clone(), Accesses);
}
