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
    private readonly Dictionary<AccessPath, TypeSymbol> narrowedVariables;
    private readonly Dictionary<AccessPath, int> narrowingFrameIndices;
    private readonly Dictionary<AccessPath, int> narrowingProofGenerations;
    private readonly Dictionary<VariableSymbol, int> assignmentGenerations;
    private ImmutableHashSet<VariableSymbol> externalCallableAliases;

    public GotoNarrowingSnapshot(
        IReadOnlyDictionary<AccessPath, TypeSymbol> narrowedVariables,
        IReadOnlyDictionary<AccessPath, int> narrowingFrameIndices,
        IReadOnlyDictionary<AccessPath, int> narrowingProofGenerations,
        IReadOnlyDictionary<VariableSymbol, int> assignmentGenerations,
        IReadOnlyCollection<VariableSymbol> externalCallableAliases,
        ImmutableArray<FinallyClauseSyntax> activeFinallyClauses,
        ImmutableArray<BoundStatement> activeCleanupStatements,
        ImmutableArray<GotoCleanupRegion> activeCleanupRegions,
        ImmutableHashSet<string> definedLabels)
    {
        this.narrowedVariables = new Dictionary<AccessPath, TypeSymbol>(narrowedVariables);
        this.narrowingFrameIndices = new Dictionary<AccessPath, int>(narrowingFrameIndices);
        this.narrowingProofGenerations = new Dictionary<AccessPath, int>(narrowingProofGenerations);
        this.assignmentGenerations = new Dictionary<VariableSymbol, int>(assignmentGenerations);
        NarrowedVariables = new ReadOnlyDictionary<AccessPath, TypeSymbol>(this.narrowedVariables);
        NarrowingFrameIndices = new ReadOnlyDictionary<AccessPath, int>(this.narrowingFrameIndices);
        NarrowingProofGenerations = new ReadOnlyDictionary<AccessPath, int>(this.narrowingProofGenerations);
        AssignmentGenerations = new ReadOnlyDictionary<VariableSymbol, int>(this.assignmentGenerations);
        this.externalCallableAliases = externalCallableAliases.ToImmutableHashSet();
        ActiveFinallyClauses = activeFinallyClauses;
        ActiveCleanupStatements = activeCleanupStatements;
        ActiveCleanupRegions = activeCleanupRegions;
        DefinedLabels = definedLabels;
    }

    public IReadOnlyDictionary<AccessPath, TypeSymbol> NarrowedVariables { get; }

    public IReadOnlyDictionary<AccessPath, int> NarrowingFrameIndices { get; }

    public IReadOnlyDictionary<AccessPath, int> NarrowingProofGenerations { get; }

    public IReadOnlyDictionary<VariableSymbol, int> AssignmentGenerations { get; }

    public ImmutableHashSet<VariableSymbol> ExternalCallableAliases => externalCallableAliases;

    public ImmutableArray<FinallyClauseSyntax> ActiveFinallyClauses { get; }

    public ImmutableArray<BoundStatement> ActiveCleanupStatements { get; }

    public ImmutableArray<GotoCleanupRegion> ActiveCleanupRegions { get; }

    public ImmutableHashSet<string> DefinedLabels { get; }

    public GotoNarrowingSnapshot Clone()
        => new(
            narrowedVariables,
            NarrowingFrameIndices,
            NarrowingProofGenerations,
            AssignmentGenerations,
            ExternalCallableAliases,
            ActiveFinallyClauses,
            ActiveCleanupStatements,
            ActiveCleanupRegions,
            DefinedLabels);

    public void RemoveNarrowing(AccessPath path)
    {
        narrowedVariables.Remove(path);
        narrowingFrameIndices.Remove(path);
        narrowingProofGenerations.Remove(path);
        if (!path.HasMembers)
        {
            assignmentGenerations.Remove(path.Root);
        }
    }

    public void SetNarrowing(AccessPath path, TypeSymbol type)
    {
        narrowedVariables[path] = type;
        narrowingFrameIndices.Remove(path);
        narrowingProofGenerations.Remove(path);
        if (!path.HasMembers)
        {
            assignmentGenerations.Remove(path.Root);
        }
    }

    public void ReplaceExternalCallableAliases(IEnumerable<VariableSymbol> aliases)
    {
        externalCallableAliases = aliases.ToImmutableHashSet();
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

    public Dictionary<AccessPath, HashSet<string>> UpstreamLabels { get; } = new();

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
    AccessPath Path,
    TextLocation Location,
    string MemberName,
    BackwardGotoNarrowingUseKind Kind,
    TypeSymbol RequiredType,
    TypeSymbol DeclaredType,
    TypeSymbol? TargetType = null)
{
    public VariableSymbol Variable => Path.Root;
}

internal sealed class BackwardGotoNarrowingEdge
{
    public BackwardGotoNarrowingEdge(
        GotoNarrowingSnapshot sourceSnapshot,
        IEnumerable<BackwardGotoNarrowingAccess> accesses)
    {
        SourceSnapshot = sourceSnapshot;
        Accesses = new List<BackwardGotoNarrowingAccess>(accesses);
    }

    public GotoNarrowingSnapshot SourceSnapshot { get; }

    public List<BackwardGotoNarrowingAccess> Accesses { get; }

    public BackwardGotoNarrowingEdge Copy()
        => new(SourceSnapshot.Clone(), Accesses);
}
