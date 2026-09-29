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

/// <summary>Classifies a narrowing-dependent use for deferred diagnostics.</summary>
internal enum BackwardGotoNarrowingUseKind
{
    /// <summary>An instance member read.</summary>
    Member,

    /// <summary>An instance or indirect function invocation.</summary>
    Function,

    /// <summary>A conversion to a non-nullable target.</summary>
    Conversion,

    /// <summary>An index operation.</summary>
    Index,

    /// <summary>Another operation that requires a non-null value.</summary>
    NonNullUse,
}

internal sealed class GotoNarrowingSnapshot
{
    private readonly Dictionary<VariableSymbol, TypeSymbol> narrowedVariables;
    private readonly Dictionary<VariableSymbol, int> narrowingFrameIndices;
    private readonly Dictionary<VariableSymbol, int> assignmentGenerations;

    public GotoNarrowingSnapshot(
        IReadOnlyDictionary<VariableSymbol, TypeSymbol> narrowedVariables,
        IReadOnlyDictionary<VariableSymbol, int> narrowingFrameIndices,
        IReadOnlyDictionary<VariableSymbol, int> assignmentGenerations,
        ImmutableArray<FinallyClauseSyntax> activeFinallyClauses)
    {
        this.narrowedVariables = new Dictionary<VariableSymbol, TypeSymbol>(narrowedVariables);
        this.narrowingFrameIndices = new Dictionary<VariableSymbol, int>(narrowingFrameIndices);
        this.assignmentGenerations = new Dictionary<VariableSymbol, int>(assignmentGenerations);
        NarrowedVariables = new ReadOnlyDictionary<VariableSymbol, TypeSymbol>(this.narrowedVariables);
        NarrowingFrameIndices = new ReadOnlyDictionary<VariableSymbol, int>(this.narrowingFrameIndices);
        AssignmentGenerations = new ReadOnlyDictionary<VariableSymbol, int>(this.assignmentGenerations);
        ActiveFinallyClauses = activeFinallyClauses;
    }

    public IReadOnlyDictionary<VariableSymbol, TypeSymbol> NarrowedVariables { get; }

    public IReadOnlyDictionary<VariableSymbol, int> NarrowingFrameIndices { get; }

    public IReadOnlyDictionary<VariableSymbol, int> AssignmentGenerations { get; }

    public ImmutableArray<FinallyClauseSyntax> ActiveFinallyClauses { get; }

    public GotoNarrowingSnapshot Clone()
        => new(narrowedVariables, NarrowingFrameIndices, AssignmentGenerations, ActiveFinallyClauses);

    public void RemoveNarrowing(VariableSymbol variable)
    {
        narrowedVariables.Remove(variable);
        narrowingFrameIndices.Remove(variable);
        assignmentGenerations.Remove(variable);
    }

    public void SetNarrowing(VariableSymbol variable, TypeSymbol type)
    {
        narrowedVariables[variable] = type;
        narrowingFrameIndices.Remove(variable);
        assignmentGenerations.Remove(variable);
    }
}

internal sealed class BackwardGotoNarrowingState
{
    public BackwardGotoNarrowingState(GotoNarrowingSnapshot targetSnapshot)
    {
        TargetSnapshot = targetSnapshot;
    }

    public GotoNarrowingSnapshot TargetSnapshot { get; }

    public List<BackwardGotoNarrowingAccess> Accesses { get; } = new();

    public List<BackwardGotoNarrowingEdge> Edges { get; } = new();

    public Dictionary<VariableSymbol, HashSet<string>> UpstreamLabels { get; } = new();

    public BackwardGotoNarrowingState Clone()
    {
        var clone = new BackwardGotoNarrowingState(TargetSnapshot.Clone());
        clone.Accesses.AddRange(Accesses);
        foreach (var edge in Edges)
        {
            clone.Edges.Add(edge.Copy());
        }

        foreach (var entry in UpstreamLabels)
        {
            clone.UpstreamLabels.Add(entry.Key, new HashSet<string>(entry.Value));
        }

        return clone;
    }
}

internal sealed record BackwardGotoNarrowingAccess(
    VariableSymbol Variable,
    TextLocation Location,
    string MemberName,
    BackwardGotoNarrowingUseKind Kind,
    TypeSymbol? TargetType = null);

internal sealed record BackwardGotoNarrowingEdge(
    GotoNarrowingSnapshot SourceSnapshot,
    ImmutableArray<BackwardGotoNarrowingAccess> Accesses)
{
    public BackwardGotoNarrowingEdge Copy()
        => new(SourceSnapshot.Clone(), Accesses);
}
