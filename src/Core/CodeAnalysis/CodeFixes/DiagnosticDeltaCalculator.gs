// <copyright file="DiagnosticDeltaCalculator.gs" company="GSharp">
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
import System.Diagnostics
import System.Linq
import System.Threading
import SystemObject = System.Object

/// Computes a (cref:DiagnosticDelta) (ADR-0227 D4): parse the changed documents, stop when the
/// parse adds a syntax diagnostic, else bind a snapshot compilation with every changed tree
/// replaced and compare all its diagnostics with the baseline.
internal shared class DiagnosticDeltaCalculator {
    func Compute(
        baseline DeltaBaseline,
        changes FixChanges,
        targets ImmutableArray[Diagnostic],
        cancellationToken CancellationToken
    ) DiagnosticDelta {
        cancellationToken.ThrowIfCancellationRequested()
        let stopwatch = Stopwatch.StartNew()
        let compilation = baseline.Compilation
        let options = baseline.EffectiveOptions
        let oldTrees = ImmutableArray.CreateBuilder[SyntaxTree]()
        let newTrees = ImmutableArray.CreateBuilder[SyntaxTree]()
        let maps = Dictionary[SourceText, DocumentMap](ReferenceEqualityComparer.Instance)
        for document in changes.Documents {
            if !compilation.SyntaxTrees.Contains(document.Tree) {
                throw ArgumentException("A changed tree is not part of the compilation.", nameof(changes))
            }
            // A diagnostic names its document by its SourceText. When two trees share one text, the
            // delta cannot tell their diagnostics apart, so it refuses the edit instead of mixing them.
            if compilation.SyntaxTrees.Count((t SyntaxTree) -> object.ReferenceEquals(t.Text, document.Tree.Text)) > 1 {
                throw ArgumentException(
                    "Two trees of the compilation share the SourceText of a changed tree; the delta cannot attribute their diagnostics (ADR-0227 D4).",
                    nameof(changes)
                )
            }
            let newTree = SyntaxTree.Parse(document.GetChangedText())
            oldTrees.Add(document.Tree)
            newTrees.Add(newTree)
            maps.Add(document.Tree.Text, DocumentMap(newTree.Text, document.Changes))
        }
        let targetList = if targets.IsDefault {
            ImmutableArray[Diagnostic].Empty
        } else {
            targets
        }
        // PhaseAware relaxes the gate only for parse errors: every target is a syntax diagnostic
        // and an error at its effective severity.
        let targetsAreSyntax = targetList.Length > 0 && targetList.All(
            (d Diagnostic) -> IsSyntaxDiagnostic(d, compilation) && Filter(ImmutableArray.Create(d), options).Any(
                (e Diagnostic) -> e.IsError
            )
        )
        // The snapshot is built now and bound only in stage 2. Its suppression scopes come from
        // the syntax, so stage 1 can apply them without a bind.
        let snapshot = compilation.WithReplacedSyntaxTrees(oldTrees.ToImmutable(), newTrees.ToImmutable())
        // Stage 1: the parse. Compare the syntax diagnostics of the changed documents only, with the
        // source suppressions and the host's filter that the compiler-visible set has.
        let syntaxBeforeChanged = Filter(
            compilation.ApplySourceSuppressions(
                oldTrees.SelectMany((t SyntaxTree) -> t.Diagnostics).ToImmutableArray()
            ),
            options
        )
        let syntaxAfterChanged = Filter(
            snapshot.ApplySourceSuppressions(newTrees.SelectMany((t SyntaxTree) -> t.Diagnostics).ToImmutableArray()),
            options
        )
        let syntaxDelta = Match(syntaxBeforeChanged, syntaxAfterChanged, maps)
        if options.SyntaxOnly || (options.StopOnNewSyntaxError && syntaxDelta.Added.Count > 0) {
            return DiagnosticDelta(
                syntaxDelta.Removed.ToImmutableArray(),
                syntaxDelta.Added.ToImmutableArray(),
                syntaxDelta.Persisting.ToImmutableArray(),
                syntaxDelta.Added.ToImmutableArray(),
                TargetsRemoved(targetList, syntaxDelta.Removed, options),
                targetsAreSyntax,
                true,
                stopwatch.Elapsed
            )
        }
        // Stage 2: the bind of the whole compilation, on this thread, under the request token.
        let budget = compilation.WorkBudget
        snapshot.WorkBudget = CompilationWorkBudget(budget.MaxWorkers, budget.MemoryBudgetMiB, cancellationToken)
        let after = Collect(snapshot, options, cancellationToken)
        let delta = Match(baseline.Diagnostics, after, maps)
        let syntaxAfter = HashSet[Diagnostic](ReferenceEqualityComparer.Instance)
        for tree in newTrees {
            for d in tree.Diagnostics {
                syntaxAfter.Add(d)
            }
        }
        let addedSyntax = delta.Added.Where((d Diagnostic) -> ContainsSameDiagnostic(syntaxAfter, d)).ToImmutableArray()
        return DiagnosticDelta(
            delta.Removed.ToImmutableArray(),
            delta.Added.ToImmutableArray(),
            delta.Persisting.ToImmutableArray(),
            addedSyntax,
            TargetsRemoved(targetList, delta.Removed, options),
            targetsAreSyntax,
            false,
            stopwatch.Elapsed
        )
    }

    // Every target is removed: a removed diagnostic has its document, ID, message, span and
    // effective severity. The comparison is by content, because the analyzers and the host's
    // filter can produce copies. A target that the host's filter drops does not count.
    private func TargetsRemoved(
        targets ImmutableArray[Diagnostic],
        removed List[Diagnostic],
        options DeltaOptions
    ) bool {
        // Each target consumes a removed occurrence of its own.
        let used = List[bool](Enumerable.Repeat(false, removed.Count))
        var any = false
        for target in targets {
            for effective in Filter(ImmutableArray.Create(target), options) {
                any = true
                var found = -1
                for var index = 0; index < removed.Count; index++ {
                    let r = removed[index]
                    if !used[index] && object.ReferenceEquals(r.Location.Text, effective.Location.Text) &&
                        r.Id == effective.Id &&
                        r.Message == effective.Message &&
                        r.Severity == effective.Severity &&
                        r
                        .Location
                        .Span
                        .Start == effective
                        .Location
                        .Span
                        .Start &&
                        r
                        .Location
                        .Span
                        .Length == effective
                        .Location
                        .Span
                        .Length {
                        found = index
                        break
                    }
                }
                if found < 0 {
                    return false
                }
                used[found] = true
            }
        }
        return any
    }

    /// Gets the diagnostics of a compilation and of the analyzers, after the host's filter.
    func Collect(compilation Compilation, options DeltaOptions, cancellationToken CancellationToken) ImmutableArray[
        Diagnostic
    ] {
        let all = List[Diagnostic](compilation.GetDiagnostics(cancellationToken))
        if !options.Analyzers.IsEmpty {
            all.AddRange(GSharpAnalyzerDriver.Run(compilation, options.Analyzers, nil, cancellationToken))
        }
        return Filter(all, options)
    }

    private func Filter(diagnostics IEnumerable[Diagnostic], options DeltaOptions) ImmutableArray[Diagnostic] {
        let filter = options.DiagnosticFilter
        if filter == nil {
            return diagnostics.ToImmutableArray()
        }
        let result = ImmutableArray.CreateBuilder[Diagnostic]()
        for d in diagnostics {
            let effective Diagnostic? = filter(d)
            if effective != nil {
                result.Add(effective)
            }
        }
        return result.ToImmutable()
    }

    // A filtered diagnostic can be a copy, so syntax membership compares the identity fields.
    private func ContainsSameDiagnostic(set HashSet[Diagnostic], d Diagnostic) bool {
        if set.Contains(d) {
            return true
        }
        for candidate in set {
            if object.ReferenceEquals(candidate.Location.Text, d.Location.Text) &&
                candidate.Id == d.Id &&
                candidate.Message == d.Message &&
                candidate
                .Location
                .Span
                .Start == d
                .Location
                .Span
                .Start &&
                candidate
                .Location
                .Span
                .Length == d
                .Location
                .Span
                .Length {
                return true
            }
        }
        return false
    }

    private func IsSyntaxDiagnostic(d Diagnostic, compilation Compilation) bool {
        for tree in compilation.SyntaxTrees {
            if object.ReferenceEquals(tree.Text, d.Location.Text) {
                for s in tree.Diagnostics {
                    if object.ReferenceEquals(s, d) ||
                        (
                        s.Id == d.Id &&
                            s.Message == d.Message &&
                            s
                            .Location
                            .Span
                            .Start == d
                            .Location
                            .Span
                            .Start &&
                            s
                            .Location
                            .Span
                            .Length == d
                            .Location
                            .Span
                            .Length
                    ) {
                        return true
                    }
                }
            }
        }
        return false
    }

    // Matches the diagnostics before and after (ADR-0227 D4). A diagnostic whose span does not touch
    // a change matches the diagnostic after with the same document, ID, severity, message and mapped
    // span. A diagnostic whose span touches a change matches a diagnostic after with the same
    // document, ID, severity and message whose span touches a changed region of the new text. Each
    // diagnostic matches at most one other, in position order.
    private func Match(
        before ImmutableArray[Diagnostic],
        after ImmutableArray[Diagnostic],
        maps Dictionary[SourceText, DocumentMap]
    ) MatchResult {
        let result = MatchResult()
        // The document of an after diagnostic: the old text of a changed document stands for its new text.
        let oldByNew = Dictionary[SourceText, SourceText](ReferenceEqualityComparer.Instance)
        for pair in maps {
            oldByNew.Add(pair.Value.NewText, pair.Key)
        }
        // Occurrences are tracked by index: one diagnostic object can be reported twice, and each
        // report is an occurrence of its own.
        let orderedAfter = after.OrderBy((x Diagnostic) -> x.Location.Span.Start).ToList()
        let matchedAfter = List[bool](Enumerable.Repeat(false, orderedAfter.Count))
        let exact = Dictionary[object, Dictionary[string, Queue[int32]]](ReferenceEqualityComparer.Instance)
        for var index = 0; index < orderedAfter.Count; index++ {
            let d = orderedAfter[index]
            var document object = NoDocument
            let text SourceText? = d.Location.Text
            if text != nil {
                document = text
                if oldByNew.TryGetValue(text, out var oldText) {
                    document = oldText
                }
            }
            if !exact.TryGetValue(document, out var keys) {
                keys = Dictionary[string, Queue[int32]](StringComparer.Ordinal)
                exact.Add(document, keys)
            }
            let key = Key(d, d.Location.Span)
            if !keys.TryGetValue(key, out var queue) {
                queue = Queue[int32]()
                keys.Add(key, queue)
            }
            queue.Enqueue(index)
        }
        let touchedBefore = List[Diagnostic]()
        for d in before.OrderBy((x Diagnostic) -> x.Location.Span.Start) {
            var document object = NoDocument
            var span = d.Location.Span
            let text SourceText? = d.Location.Text
            if text != nil {
                document = text
                if maps.TryGetValue(text, out var documentMap) && !documentMap.TryMapSpan(d.Location.Span, out span) {
                    touchedBefore.Add(d)
                    continue
                }
            }
            if exact.TryGetValue(document, out var keys) && keys.TryGetValue(Key(d, span), out var queue) &&
                queue.Count > 0 {
                let other = queue.Dequeue()
                matchedAfter[other] = true
                result.Persisting.Add(orderedAfter[other])
            } else {
                result.Removed.Add(d)
            }
        }
        for d in touchedBefore {
            let documentMap = maps[d.Location.Text!!]
            let newText = documentMap.NewText
            var found = -1
            for var index = 0; index < orderedAfter.Count; index++ {
                let candidate = orderedAfter[index]
                if !matchedAfter[index] && object.ReferenceEquals(candidate.Location.Text, newText) &&
                    documentMap.TouchesNewRegion(candidate.Location.Span) &&
                    candidate.Id == d.Id &&
                    candidate.Severity == d.Severity &&
                    candidate.Message == d.Message {
                    found = index
                    break
                }
            }
            if found >= 0 {
                matchedAfter[found] = true
                result.Persisting.Add(orderedAfter[found])
            } else {
                result.Removed.Add(d)
            }
        }
        for var index = 0; index < orderedAfter.Count; index++ {
            if !matchedAfter[index] {
                result.Added.Add(orderedAfter[index])
            }
        }
        return result
    }

    private let NoDocument object = SystemObject()

    private func Key(
        d Diagnostic,
        span TextSpan
    ) string -> "${d.Id}|${cast[int32](d.Severity)}|${span.Start}|${span.Length}|${d.Message}"

    private class MatchResult {
        let Removed List[Diagnostic] = List[Diagnostic]()
        let Added List[Diagnostic] = List[Diagnostic]()
        let Persisting List[Diagnostic] = List[Diagnostic]()
    }
}

/// Maps spans of one changed document from the old text to the new text (ADR-0227 D4).
internal class DocumentMap {
    private let changes ImmutableArray[TextChange]
    private let newRegions ImmutableArray[TextSpan]

    init(newText SourceText, changes ImmutableArray[TextChange]) {
        NewText = newText
        this.changes = changes
        let regions = ImmutableArray.CreateBuilder[TextSpan]()
        var delta = 0
        for change in changes {
            regions.Add(TextSpan(change.Span.Start + delta, change.NewText.Length))
            delta += change.NewText.Length - change.Span.Length
        }
        newRegions = regions.ToImmutable()
    }

    prop NewText SourceText {
        get;
    }

    /// Maps a span of the old text. It fails when a change overlaps or touches the span, as
    /// (cref:TouchesNewRegion) does for the new text: an edit at a boundary (`foo` → `foox`, a
    /// newline before a report at position 0) leaves the span to the touched-region match.
    func TryMapSpan(span TextSpan, out mapped TextSpan) bool {
        var shift = 0
        for change in changes {
            let c = change.Span
            if c.Start <= span.End && span.Start <= c.End {
                mapped = span
                return false
            }
            if c.End <= span.Start {
                shift += change.NewText.Length - c.Length
            }
        }
        mapped = TextSpan(span.Start + shift, span.Length)
        return true
    }

    /// Returns a value that tells whether a span of the new text overlaps or touches a changed region.
    func TouchesNewRegion(span TextSpan) bool {
        for region in newRegions {
            if region.Start <= span.End && span.Start <= region.End {
                return true
            }
        }
        return false
    }
}
