// <copyright file="GotoNarrowingSnapshot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Collections.ObjectModel

/// Classifies a narrowing-dependent use for deferred diagnostics.
internal enum BackwardGotoNarrowingUseKind {
    Member,
    Function,
    Conversion,
    Index,
    NonNullUse
}

internal class GotoNarrowingSnapshot {
    private let narrowedVariables Dictionary[AccessPath, TypeSymbol]
    private let narrowingFrameIndices Dictionary[AccessPath, int32]
    private let narrowingProofGenerations Dictionary[AccessPath, int32]
    private let assignmentGenerations Dictionary[VariableSymbol, int32]
    private var externalCallableAliases ImmutableHashSet[VariableSymbol]

    init(
        narrowedVariables IReadOnlyDictionary[AccessPath, TypeSymbol],
        narrowingFrameIndices IReadOnlyDictionary[AccessPath, int32],
        narrowingProofGenerations IReadOnlyDictionary[AccessPath, int32],
        assignmentGenerations IReadOnlyDictionary[VariableSymbol, int32],
        externalCallableAliases IReadOnlyCollection[VariableSymbol],
        activeFinallyClauses ImmutableArray[FinallyClauseSyntax],
        activeCleanupStatements ImmutableArray[BoundStatement],
        activeCleanupRegions ImmutableArray[GotoCleanupRegion],
        definedLabels ImmutableHashSet[string]
    ) {
        this.narrowedVariables = Dictionary[AccessPath, TypeSymbol](narrowedVariables)
        this.narrowingFrameIndices = Dictionary[AccessPath, int32](narrowingFrameIndices)
        this.narrowingProofGenerations = Dictionary[AccessPath, int32](narrowingProofGenerations)
        this.assignmentGenerations = Dictionary[VariableSymbol, int32](assignmentGenerations)
        NarrowedVariables = ReadOnlyDictionary[AccessPath, TypeSymbol](this.narrowedVariables)
        NarrowingFrameIndices = ReadOnlyDictionary[AccessPath, int32](this.narrowingFrameIndices)
        NarrowingProofGenerations = ReadOnlyDictionary[AccessPath, int32](this.narrowingProofGenerations)
        AssignmentGenerations = ReadOnlyDictionary[VariableSymbol, int32](this.assignmentGenerations)
        this.externalCallableAliases = externalCallableAliases.ToImmutableHashSet()
        ActiveFinallyClauses = activeFinallyClauses
        ActiveCleanupStatements = activeCleanupStatements
        ActiveCleanupRegions = activeCleanupRegions
        DefinedLabels = definedLabels
    }

    prop NarrowedVariables IReadOnlyDictionary[AccessPath, TypeSymbol] {
        get;
    }

    prop NarrowingFrameIndices IReadOnlyDictionary[AccessPath, int32] {
        get;
    }

    prop NarrowingProofGenerations IReadOnlyDictionary[AccessPath, int32] {
        get;
    }

    prop AssignmentGenerations IReadOnlyDictionary[VariableSymbol, int32] {
        get;
    }

    prop ExternalCallableAliases ImmutableHashSet[VariableSymbol] -> externalCallableAliases

    prop ActiveFinallyClauses ImmutableArray[FinallyClauseSyntax] {
        get;
    }

    prop ActiveCleanupStatements ImmutableArray[BoundStatement] {
        get;
    }

    prop ActiveCleanupRegions ImmutableArray[GotoCleanupRegion] {
        get;
    }

    prop DefinedLabels ImmutableHashSet[string] {
        get;
    }

    func Clone() GotoNarrowingSnapshot -> GotoNarrowingSnapshot(
        narrowedVariables,
        NarrowingFrameIndices,
        NarrowingProofGenerations,
        AssignmentGenerations,
        ExternalCallableAliases,
        ActiveFinallyClauses,
        ActiveCleanupStatements,
        ActiveCleanupRegions,
        DefinedLabels
    )

    func RemoveNarrowing(path AccessPath) {
        narrowedVariables.Remove(path)
        narrowingFrameIndices.Remove(path)
        narrowingProofGenerations.Remove(path)
        if !path.HasMembers {
            assignmentGenerations.Remove(path.Root)
        }
    }

    func SetNarrowing(path AccessPath, type TypeSymbol) {
        narrowedVariables[path] = type
        narrowingFrameIndices.Remove(path)
        narrowingProofGenerations.Remove(path)
        if !path.HasMembers {
            assignmentGenerations.Remove(path.Root)
        }
    }

    func ReplaceExternalCallableAliases(aliases IEnumerable[VariableSymbol]) {
        externalCallableAliases = aliases.ToImmutableHashSet()
    }
}

internal class BackwardGotoNarrowingState {
    init(targetSnapshot GotoNarrowingSnapshot) {
        Accesses = List[BackwardGotoNarrowingAccess]()
        Edges = List[BackwardGotoNarrowingEdge]()
        UpstreamLabels = Dictionary[AccessPath, HashSet[string]]()
        TargetSnapshot = targetSnapshot
    }

    prop TargetSnapshot GotoNarrowingSnapshot {
        get;
    }

    prop Accesses List[BackwardGotoNarrowingAccess] {
        get;
    }

    prop Edges List[BackwardGotoNarrowingEdge] {
        get;
    }

    prop UpstreamLabels Dictionary[AccessPath, HashSet[string]] {
        get;
    }

    func Clone() BackwardGotoNarrowingState {
        let clone = BackwardGotoNarrowingState(TargetSnapshot.Clone())
        clone.Accesses.AddRange(Accesses)
        for edge in Edges {
            clone.Edges.Add(edge.Copy())
        }
        for entry in UpstreamLabels {
            clone.UpstreamLabels.Add(entry.Key, HashSet[string](entry.Value))
        }
        return clone
    }
}

internal data class BackwardGotoNarrowingAccess(
    Path AccessPath,
    Location TextLocation,
    MemberName string,
    Kind BackwardGotoNarrowingUseKind,
    RequiredType TypeSymbol,
    DeclaredType TypeSymbol,
    TargetType TypeSymbol? = nil,
    HeldBy LambdaBinder.DeferredReturnState? = nil
) : IEquatable[BackwardGotoNarrowingAccess] {
    prop Variable VariableSymbol -> Path.Root
}

internal class BackwardGotoNarrowingEdge {
    init(sourceSnapshot GotoNarrowingSnapshot, accesses IEnumerable[BackwardGotoNarrowingAccess]) {
        SourceSnapshot = sourceSnapshot
        Accesses = List[BackwardGotoNarrowingAccess](accesses)
    }

    prop SourceSnapshot GotoNarrowingSnapshot {
        get;
    }

    prop Accesses List[BackwardGotoNarrowingAccess] {
        get;
    }

    func Copy() BackwardGotoNarrowingEdge -> BackwardGotoNarrowingEdge(SourceSnapshot.Clone(), Accesses)
}
