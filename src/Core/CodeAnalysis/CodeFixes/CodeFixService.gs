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
                fixes.AddRange(context.Fixes)
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
