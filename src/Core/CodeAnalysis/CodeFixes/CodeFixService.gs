// <copyright file="CodeFixService.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading

/// Lists and applies code fixes (ADR-0227 D2). The language server and library hosts use the
/// same service. The service never changes the compilations that it gets.
class CodeFixService {
    /// Initializes a new instance of the (cref:CodeFixService) class.
    /// @param registry The providers.
    init(registry CodeFixRegistry) {
        ArgumentNullException.ThrowIfNull(registry)
        Registry = registry
    }

    /// Gets the providers of the service.
    prop Registry CodeFixRegistry {
        get;
    }

    /// Gets the fixes for one diagnostic, in registry order.
    /// @param compilation The compilation that reported the diagnostic.
    /// @param diagnostic The diagnostic.
    /// @param cancellationToken Cancels the providers.
    /// @returns The fixes.
    func GetFixes(
        compilation Compilation,
        diagnostic Diagnostic,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[CodeFix] -> GetFixes(compilation, diagnostic, out _, cancellationToken)

    /// Gets the fixes for one diagnostic, in registry order. A provider that throws gives no fix
    /// and a GS9308 diagnostic.
    /// @param compilation The compilation that reported the diagnostic.
    /// @param diagnostic The diagnostic.
    /// @param providerDiagnostics GS9308 for each provider that threw.
    /// @param cancellationToken Cancels the providers.
    /// @returns The fixes.
    func GetFixes(
        compilation Compilation,
        diagnostic Diagnostic,
        out providerDiagnostics ImmutableArray[Diagnostic],
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[CodeFix] {
        ArgumentNullException.ThrowIfNull(compilation)
        ArgumentNullException.ThrowIfNull(diagnostic)
        let fixes = ImmutableArray.CreateBuilder[CodeFix]()
        let failures = ImmutableArray.CreateBuilder[Diagnostic]()
        let tree SyntaxTree? = FindTree(compilation, diagnostic)
        if tree != nil {
            Collect(compilation, tree, diagnostic, fixes, failures, cancellationToken)
        }
        providerDiagnostics = failures.ToImmutable()
        return fixes.ToImmutable()
    }

    /// Gets the fixes for the diagnostics of [`tree`](paramref) whose span overlaps
    /// [`span`](paramref), in diagnostic order and then registry order. Two non-empty spans overlap
    /// when they share a character. A zero-length span hits a diagnostic that contains or touches it.
    /// @param compilation The compilation of the tree.
    /// @param tree A tree of the compilation.
    /// @param span The span.
    /// @param additionalDiagnostics Diagnostics that the compilation does not report, such as analyzer diagnostics.
    /// @param providerDiagnostics GS9308 for each provider that threw.
    /// @param cancellationToken Cancels the providers.
    /// @returns The fixes.
    func GetFixes(
        compilation Compilation,
        tree SyntaxTree,
        span TextSpan,
        additionalDiagnostics ImmutableArray[Diagnostic],
        out providerDiagnostics ImmutableArray[Diagnostic],
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[CodeFix] {
        ArgumentNullException.ThrowIfNull(compilation)
        ArgumentNullException.ThrowIfNull(tree)
        if !compilation.SyntaxTrees.Contains(tree) {
            throw ArgumentException("The tree is not part of the compilation.", nameof(tree))
        }
        let fixes = ImmutableArray.CreateBuilder[CodeFix]()
        let failures = ImmutableArray.CreateBuilder[Diagnostic]()
        for diagnostic in DiagnosticsOf(compilation, tree, additionalDiagnostics, cancellationToken) {
            cancellationToken.ThrowIfCancellationRequested()
            let location = diagnostic.Location.Span
            if Overlaps(location, span) {
                Collect(compilation, tree, diagnostic, fixes, failures, cancellationToken)
            }
        }
        providerDiagnostics = failures.ToImmutable()
        return fixes.ToImmutable()
    }

    /// Applies a fix and parses each changed document again.
    /// @param fix The fix.
    /// @param cancellationToken Cancels the computation of the changes.
    /// @returns The new tree of each changed document, in the order of (cref:FixChanges.Documents).
    func Apply(fix CodeFix, cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[
        SyntaxTree
    ] {
        ArgumentNullException.ThrowIfNull(fix)
        let result = ImmutableArray.CreateBuilder[SyntaxTree]()
        for document in fix.GetChanges(cancellationToken).Documents {
            result.Add(SyntaxTree.Parse(document.GetChangedText()))
        }
        return result.ToImmutable()
    }

    /// Computes the diagnostic delta of a fix over the whole compilation (ADR-0227 D4).
    /// @param compilation The compilation before the fix. It is not changed.
    /// @param fix The fix.
    /// @param options The options; `null` uses the defaults.
    /// @param cancellationToken Cancels the check, including the bind of the snapshot compilation.
    /// @returns The delta.
    func ComputeDelta(
        compilation Compilation,
        fix CodeFix,
        options DeltaOptions? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) DiagnosticDelta -> ComputeDelta(
        DeltaBaseline.Create(compilation, options, cancellationToken),
        fix,
        cancellationToken
    )

    /// Computes the diagnostic delta of a fix against a baseline that the checks of one request share.
    /// @param baseline The diagnostics before the fix.
    /// @param fix The fix.
    /// @param cancellationToken Cancels the check, including the bind of the snapshot compilation.
    /// @returns The delta.
    func ComputeDelta(
        baseline DeltaBaseline,
        fix CodeFix,
        cancellationToken CancellationToken = default(CancellationToken)
    ) DiagnosticDelta {
        ArgumentNullException.ThrowIfNull(baseline)
        ArgumentNullException.ThrowIfNull(fix)
        return ComputeDelta(baseline, fix.GetChanges(cancellationToken), fix.Diagnostics, cancellationToken)
    }

    /// Computes the diagnostic delta of a complete edit set, such as the result of a FixAll.
    /// @param baseline The diagnostics before the edit.
    /// @param changes The changes of every edited document.
    /// @param targets The diagnostics that the edit is for.
    /// @param cancellationToken Cancels the check, including the bind of the snapshot compilation.
    /// @returns The delta.
    func ComputeDelta(
        baseline DeltaBaseline,
        changes FixChanges,
        targets ImmutableArray[Diagnostic],
        cancellationToken CancellationToken = default(CancellationToken)
    ) DiagnosticDelta {
        ArgumentNullException.ThrowIfNull(baseline)
        ArgumentNullException.ThrowIfNull(changes)
        return DiagnosticDeltaCalculator.Compute(baseline, changes, targets, cancellationToken)
    }

    /// Applies the fixes of every diagnostic in [`fixAllScope`](paramref) that have the equivalence key,
    /// with the batch fixer (ADR-0227 D3). Each round computes the fixes against one snapshot and
    /// keeps the fixes whose changes do not overlap. The compilations of the scope do not change.
    /// @param fixAllScope The trees and compilations.
    /// @param equivalenceKey The key of the fixes, or `null` for the first fix of each diagnostic.
    /// @param options The options; `null` uses the defaults (machine-applicable fixes, one round).
    /// @param cancellationToken Cancels the FixAll.
    /// @returns The applied and dropped fixes, the changed documents and the new compilations.
    func FixAll(
        fixAllScope FixAllScope,
        equivalenceKey string?,
        options FixAllOptions? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) FixAllResult {
        ArgumentNullException.ThrowIfNull(fixAllScope)
        return BatchFixer(this, equivalenceKey, options ?? FixAllOptions()).Run(fixAllScope, cancellationToken)
    }

    private func Collect(
        compilation Compilation,
        tree SyntaxTree,
        diagnostic Diagnostic,
        fixes ImmutableArray[CodeFix].Builder,
        failures ImmutableArray[Diagnostic].Builder,
        cancellationToken CancellationToken
    ) {
        for provider in Registry.GetProviders(diagnostic.Id) {
            cancellationToken.ThrowIfCancellationRequested()
            let context = CodeFixContext(diagnostic, tree, compilation, provider.Id, cancellationToken)
            try {
                provider.RegisterCodeFixes(context)
                for fix in context.Fixes {
                    fix.MarkProvider(provider)
                    fixes.Add(fix)
                }
            } catch (OperationCanceledException) when cancellationToken.IsCancellationRequested {
                rethrow
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                failures.Add(
                    Diagnostic.Create(
                        DiagnosticDescriptors.CodeFixProviderFailure,
                        diagnostic.Location,
                        provider.Id,
                        diagnostic.Id,
                        "${ex.GetType().Name}: ${ex.Message}"
                    )
                )
            }
        }
    }

    shared {
        // Two non-empty spans overlap when they share a character. A zero-length span (a caret)
        // hits a span that contains or touches it.
        internal func Overlaps(a TextSpan, b TextSpan) bool {
            if a.Length == 0 || b.Length == 0 {
                return a.Start <= b.End && b.Start <= a.End
            }
            return a.Start < b.End && b.Start < a.End
        }

        // The diagnostics of one tree in GetDiagnostics order, then the additional ones in their order.
        internal func DiagnosticsOf(
            compilation Compilation,
            tree SyntaxTree,
            additionalDiagnostics ImmutableArray[Diagnostic],
            cancellationToken CancellationToken
        ) sequence[Diagnostic] {
            for diagnostic in compilation.GetDiagnostics(cancellationToken) {
                if object.ReferenceEquals(diagnostic.Location.Text, tree.Text) {
                    yield diagnostic
                }
            }
            if !additionalDiagnostics.IsDefault {
                for diagnostic in additionalDiagnostics {
                    if object.ReferenceEquals(diagnostic.Location.Text, tree.Text) {
                        yield diagnostic
                    }
                }
            }
        }

        internal func FindTree(compilation Compilation, diagnostic Diagnostic) SyntaxTree? {
            let text SourceText? = diagnostic.Location.Text
            if text == nil {
                return nil
            }
            for tree in compilation.SyntaxTrees {
                if object.ReferenceEquals(tree.Text, text) {
                    return tree
                }
            }
            return nil
        }
    }
}
