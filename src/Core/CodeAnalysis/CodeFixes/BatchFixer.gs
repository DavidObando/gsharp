// <copyright file="BatchFixer.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading

/// The batch FixAll of ADR-0227 D3, like Roslyn's batch fixer. Each round computes every fix
/// against one snapshot, keeps a fix only when none of its changes overlaps or touches a change
/// of a fix that it already kept, applies the kept changes at once and parses again.
internal class BatchFixer {
    private let service CodeFixService
    private let equivalenceKey string?
    private let options FixAllOptions
    private let applied ImmutableArray[CodeFix].Builder = ImmutableArray.CreateBuilder[CodeFix]()
    private let dropped ImmutableArray[DroppedFix].Builder = ImmutableArray.CreateBuilder[DroppedFix]()

    init(service CodeFixService, equivalenceKey string?, options FixAllOptions) {
        this.service = service
        this.equivalenceKey = equivalenceKey
        this.options = options
    }

    func Run(fixAllScope FixAllScope, cancellationToken CancellationToken) FixAllResult {
        let documents = List[FixAllDocument]()
        let compilations = ImmutableArray.CreateBuilder[Compilation]()
        var rounds = 0
        for compilation in fixAllScope.Compilations {
            let indexes = if fixAllScope.Tree != nil {
                ImmutableArray.Create(compilation.SyntaxTrees.IndexOf(fixAllScope.Tree))
            } else {
                Enumerable.Range(0, compilation.SyntaxTrees.Length).ToImmutableArray()
            }
            var current = compilation
            for var round = 1; round <= options.MaxRounds; round++ {
                cancellationToken.ThrowIfCancellationRequested()
                rounds = Math.Max(rounds, round)
                let next Compilation? = RunRound(current, indexes, round, cancellationToken, out var again)
                if next == nil {
                    break
                }
                current = next
                if !again {
                    break
                }
            }
            // A fix of a selected diagnostic can edit other trees too, so every tree is compared.
            for var index = 0; index < compilation.SyntaxTrees.Length; index++ {
                let original = compilation.SyntaxTrees[index]
                let changed = current.SyntaxTrees[index]
                if !object.ReferenceEquals(original, changed) {
                    documents.Add(FixAllDocument(original, changed))
                }
            }
            compilations.Add(current)
        }
        return FixAllResult(
            applied.ToImmutable(),
            dropped.ToImmutable(),
            documents.OrderBy((d FixAllDocument) -> d.Original.Text.FileName, StringComparer.Ordinal)
                .ToImmutableArray(),
            compilations.ToImmutable(),
            rounds
        )
    }

    // One round. Returns the successor compilation, or null when no fix applies. `again` tells
    // whether a fix was dropped for an overlap, so a later round can apply it.
    private func RunRound(
        compilation Compilation,
        indexes ImmutableArray[int32],
        round int32,
        cancellationToken CancellationToken,
        out again bool
    ) Compilation? {
        again = false
        let trees = indexes.Select((i int32) -> compilation.SyntaxTrees[i]).ToList()
        let kept = List[KeptFix]()
        let keptByTree = Dictionary[SyntaxTree, List[TextChange]]()
        for diagnostic in Diagnostics(compilation, trees, cancellationToken) {
            let fix CodeFix? = ChooseFix(compilation, diagnostic, round, cancellationToken)
            if fix == nil {
                continue
            }
            if CodeFix.Rank(fix.Applicability) > CodeFix.Rank(options.MinimumApplicability) {
                dropped.Add(DroppedFix(diagnostic, fix, FixDropReason.ApplicabilityFiltered, round))
                continue
            }
            // A provider's deferred computation can throw; that fix is dropped and the others go on.
            var changes FixChanges? = nil
            try {
                changes = fix.GetChanges(cancellationToken)
                // A fix built by hand can carry changes that do not apply: a tree of another
                // compilation, a span outside the text, or overlapping changes. It fails here.
                for document in changes.Documents {
                    if !compilation.SyntaxTrees.Contains(document.Tree) {
                        throw ArgumentException("The fix changes a tree of another compilation.")
                    }
                    document.Tree.Text.WithChanges(document.Changes)
                }
            } catch (ex OperationCanceledException) when cancellationToken.IsCancellationRequested {
                rethrow
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                dropped.Add(DroppedFix(diagnostic, fix, FixDropReason.ProviderFailed, round))
                continue
            }
            if changes.IsEmpty || Conflicts(changes, keptByTree) {
                if !changes.IsEmpty {
                    dropped.Add(DroppedFix(diagnostic, fix, FixDropReason.Overlap, round))
                    again = true
                }
                continue
            }
            for document in changes.Documents {
                if !keptByTree.TryGetValue(document.Tree, out var list) {
                    list = List[TextChange]()
                    keptByTree.Add(document.Tree, list)
                }
                list.AddRange(document.Changes)
            }
            kept.Add(KeptFix(diagnostic, fix))
        }
        if kept.Count == 0 {
            again = false
            return nil
        }
        let documents = ImmutableArray.CreateBuilder[DocumentChanges]()
        for pair in keptByTree {
            let list = pair.Value
            // Position order; at one position the insertions come first; then the order of the fixes.
            let ordered = Enumerable
                .Range(0, list.Count)
                .OrderBy((i int32) -> list[i].Span.Start)
                .ThenBy((i int32) -> InsertionRank(list[i]))
                .ThenBy((i int32) -> i)
                .Select((i int32) -> list[i])
                .ToImmutableArray()
            documents.Add(DocumentChanges(pair.Key, ordered, ImmutableArray[TextSpan].Empty))
        }
        let combined = FixChanges(documents.ToImmutable())
        let gate DeltaPolicy? = options.Gate
        if gate != nil {
            let baseline = DeltaBaseline.Create(compilation, options.DeltaOptions, cancellationToken)
            // The targets are every diagnostic that a kept fix declares, each occurrence once.
            let targets = ImmutableArray.CreateBuilder[Diagnostic]()
            let seenTargets = HashSet[Diagnostic](ReferenceEqualityComparer.Instance)
            for k in kept {
                for target in k.Fix.Diagnostics {
                    if seenTargets.Add(target) {
                        targets.Add(target)
                    }
                }
            }
            let delta = service.ComputeDelta(baseline, combined, targets.ToImmutable(), cancellationToken)
            if !gate.Accepts(delta) {
                for k in kept {
                    dropped.Add(DroppedFix(k.Diagnostic, k.Fix, FixDropReason.DeltaRejected, round))
                }
                again = false
                return nil
            }
        }
        let oldTrees = ImmutableArray.CreateBuilder[SyntaxTree]()
        let newTrees = ImmutableArray.CreateBuilder[SyntaxTree]()
        for document in combined.Documents {
            oldTrees.Add(document.Tree)
            newTrees.Add(SyntaxTree.Parse(document.GetChangedText()))
        }
        for k in kept {
            applied.Add(k.Fix)
        }
        let successor = compilation.WithReplacedSyntaxTrees(oldTrees.ToImmutable(), newTrees.ToImmutable())
        // The next round binds the successor: it gets the host's limits and the request token.
        let budget = compilation.WorkBudget
        successor.WorkBudget = CompilationWorkBudget(budget.MaxWorkers, budget.MemoryBudgetMiB, cancellationToken)
        return successor
    }

    // The fix of a diagnostic: the first fix with the equivalence key, or the first fix when the key is null.
    private func ChooseFix(
        compilation Compilation,
        diagnostic Diagnostic,
        round int32,
        cancellationToken CancellationToken
    ) CodeFix? {
        let fixes = service.GetFixes(compilation, diagnostic, out var failures, cancellationToken)
        for failure in failures {
            dropped.Add(DroppedFix(diagnostic, nil, FixDropReason.ProviderFailed, round))
        }
        for fix in fixes {
            if equivalenceKey != nil && fix.EquivalenceKey != equivalenceKey {
                continue
            }
            // The provider instance that registered the fix decides; provider IDs can repeat.
            let provider GSharpCodeFixProvider? = fix.Provider
            if provider != nil && !provider.SupportsFixAll {
                dropped.Add(DroppedFix(diagnostic, fix, FixDropReason.NotSupported, round))
                return nil
            }
            return fix
        }
        return nil
    }

    // The diagnostics of the trees in GetDiagnostics order, then the analyzer diagnostics.
    private func Diagnostics(compilation Compilation, trees List[SyntaxTree], cancellationToken CancellationToken) List[
        Diagnostic
    ] {
        let texts = HashSet[SourceText](trees.Select((t SyntaxTree) -> t.Text), ReferenceEqualityComparer.Instance)
        // The document order is the ordinal order of the file names, then the tree order, so the
        // winner of a conflict does not depend on the order of the compilation's trees.
        let order = Dictionary[SourceText, int32](ReferenceEqualityComparer.Instance)
        let ranked = List[SyntaxTree](compilation.SyntaxTrees)
        ranked.Sort(CompareByFileName(compilation))
        for var rank = 0; rank < ranked.Count; rank++ {
            if !order.ContainsKey(ranked[rank].Text) {
                order.Add(ranked[rank].Text, rank)
            }
        }
        let result = List[Diagnostic]()
        for d in compilation.GetDiagnostics(cancellationToken) {
            if d.Location.Text != nil && texts.Contains(d.Location.Text) {
                result.Add(d)
            }
        }
        let analyzers = options.DeltaOptions?.Analyzers ?? ImmutableArray[GSharpDiagnosticAnalyzer].Empty
        if !analyzers.IsEmpty {
            for d in GSharpAnalyzerDriver.Run(
                compilation,
                analyzers,
                options.DeltaOptions?.AnalyzerOptions,
                cancellationToken
            ) {
                if d.Location.Text != nil && texts.Contains(d.Location.Text) {
                    result.Add(d)
                }
            }
        }
        // First wins in source order: by tree, then position; ties keep their order (a stable sort).
        return result
            .Select((d Diagnostic, i int32) -> (Diagnostic: d, Index: i))
            .OrderBy((x(Diagnostic Diagnostic, Index int32)) -> order[x.Diagnostic.Location.Text!!])
            .ThenBy((x(Diagnostic Diagnostic, Index int32)) -> x.Diagnostic.Location.Span.Start)
            .ThenBy((x(Diagnostic Diagnostic, Index int32)) -> x.Index)
            .Select((x(Diagnostic Diagnostic, Index int32)) -> x.Diagnostic)
            .ToList()
    }

    // Two changes of different fixes conflict when they share a character, or when an insertion
    // touches the other change.
    private func Conflicts(changes FixChanges, keptByTree Dictionary[SyntaxTree, List[TextChange]]) bool {
        for document in changes.Documents {
            if !keptByTree.TryGetValue(document.Tree, out var kept) {
                continue
            }
            for change in document.Changes {
                for other in kept {
                    let a = change.Span
                    let b = other.Span
                    let conflict = if a.Length > 0 && b.Length > 0 {
                        a.Start < b.End && b.Start < a.End
                    } else {
                        a.Start <= b.End && b.Start <= a.End
                    }
                    if conflict {
                        return true
                    }
                }
            }
        }
        return false
    }

    // Ordinal file name, then the position in the compilation.
    private func CompareByFileName(compilation Compilation) Comparison[SyntaxTree] -> (
        x SyntaxTree,
        y SyntaxTree
    ) -> CompareTrees(compilation, x, y)

    private func CompareTrees(compilation Compilation, x SyntaxTree, y SyntaxTree) int32 {
        let byName = string.CompareOrdinal(x.Text.FileName, y.Text.FileName)
        if byName != 0 {
            return byName
        }
        return compilation.SyntaxTrees.IndexOf(x) - compilation.SyntaxTrees.IndexOf(y)
    }

    private func InsertionRank(change TextChange) int32 -> if change.Span.Length == 0 {
        0
    } else {
        1
    }

    private class KeptFix {
        init(diagnostic Diagnostic, fix CodeFix) {
            Diagnostic = diagnostic
            Fix = fix
        }

        prop Diagnostic Diagnostic {
            get;
        }

        prop Fix CodeFix {
            get;
        }
    }
}
