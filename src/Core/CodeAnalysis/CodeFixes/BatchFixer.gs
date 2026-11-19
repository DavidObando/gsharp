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
            for index in indexes {
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
            let changes = fix.GetChanges(cancellationToken)
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
            let delta = service.ComputeDelta(
                baseline,
                combined,
                kept.Select((k KeptFix) -> k.Diagnostic).ToImmutableArray(),
                cancellationToken
            )
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
        return compilation.WithReplacedSyntaxTrees(oldTrees.ToImmutable(), newTrees.ToImmutable())
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
            let provider GSharpCodeFixProvider? = service
                .Registry
                .Providers
                .FirstOrDefault((p GSharpCodeFixProvider) -> p.Id == fix.ProviderId)
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
        let result = List[Diagnostic]()
        for d in compilation.GetDiagnostics(cancellationToken) {
            if d.Location.Text != nil && texts.Contains(d.Location.Text) {
                result.Add(d)
            }
        }
        let analyzers = options.DeltaOptions?.Analyzers ?? ImmutableArray[GSharpDiagnosticAnalyzer].Empty
        if !analyzers.IsEmpty {
            for d in GSharpAnalyzerDriver.Run(compilation, analyzers, nil, cancellationToken) {
                if d.Location.Text != nil && texts.Contains(d.Location.Text) {
                    result.Add(d)
                }
            }
        }
        return result
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
