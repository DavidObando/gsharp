// <copyright file="PrefixDiagnosticClassifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Threading

/// Gives each diagnostic of a prefix bind its finality (ADR-0225).
/// @remarks The binder stamps a premise when it reports a diagnostic. This class adds the facts that
/// only the parse and the source tree know: text that the bind removed, and parse diagnostics that
/// the seal caused. A diagnostic without a premise is final.
internal sealed class PrefixDiagnosticClassifier {
    private let source Compilation
    private let sourceTree SyntaxTree
    private let prefixCut PrefixCut
    private let cancellationToken CancellationToken
    private let prefixTree SyntaxTree
    private let prefixParse HashSet[Diagnostic]
    private var sourceParse HashSet[string]?
    private var sourceDiagnostics HashSet[string]?

    internal init(
        source Compilation,
        sourceTree SyntaxTree,
        prefixTree SyntaxTree,
        prefixCut PrefixCut,
        cancellationToken CancellationToken
    ) {
        this.source = source
        this.sourceTree = sourceTree
        this.prefixCut = prefixCut
        this.prefixTree = prefixTree
        this.cancellationToken = cancellationToken
        prefixParse = HashSet[Diagnostic](prefixTree.Diagnostics, ReferenceEqualityComparer.Instance)
    }

    /// Returns the classified form of [`diagnostic`](paramref).
    /// @param diagnostic A diagnostic of the prefix compilation.
    /// @returns The diagnostic with its finality.
    internal func Classify(diagnostic Diagnostic) ClassifiedDiagnostic {
        let location = diagnostic.Location
        if prefixCut.IsRemoved(location) {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
        }
        let inPrefixText = object.ReferenceEquals(location.Text, prefixCut.Text)
        // A parse diagnostic that reaches the cut is on a token or a construct that the cut ended, such
        // as an unterminated string. Text after the cut can complete it.
        if inPrefixText && prefixParse.Contains(diagnostic) && location.Span.End >= prefixCut.Cut {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
        }
        // The tokens before the cut are the same in both parses. A parse diagnostic that the source tree
        // does not report there comes from the closing tokens at the cut.
        if inPrefixText && prefixParse.Contains(diagnostic) && location.Span.Start < prefixCut.Cut {
            if sourceParse == nil {
                sourceParse = Keys(sourceTree.Diagnostics)
            }
            if !sourceParse!!.Contains(Key(diagnostic)) {
                return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.Artifact, "cut")
            }
        }
        // A diagnostic on a construct that is open at the cut (a call whose argument list the seal
        // closed) depends on the rest of the construct.
        if inPrefixText &&
            diagnostic.PrefixFinality == DiagnosticFinality.Final &&
            location
            .Span
            .Start < prefixCut.Cut &&
            location
            .Span
            .End == prefixCut.Cut &&
            IsOnOpenConstruct(location.Span) {
            return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.FutureDependent, "rest-of-statement")
        }
        // Kept text after the cut can depend on the text that the bind removed. The source compilation
        // is a completion of the prefix, so a diagnostic that it does not report is not final.
        if inPrefixText &&
            location
            .Span
            .Start >= prefixCut.KeptStart &&
            diagnostic.PrefixFinality == DiagnosticFinality
            .Final {
            if sourceDiagnostics == nil {
                sourceDiagnostics = Keys(source.GetDiagnostics(cancellationToken))
            }
            if !sourceDiagnostics!!.Contains(Key(diagnostic)) {
                return ClassifiedDiagnostic(diagnostic, DiagnosticFinality.FutureDependent, "rest-of-body")
            }
        }
        return ClassifiedDiagnostic(diagnostic, diagnostic.PrefixFinality, diagnostic.PrefixReason)
    }

    // Returns true when a node with exactly this span is open at the cut.
    private func IsOnOpenConstruct(span TextSpan) bool {
        var node SyntaxNode = prefixTree.Root
        while true {
            if node.Span.Start == span.Start && node.Span.End == span.End && PrefixBindingContext.IsOpen(node) {
                return true
            }
            var next SyntaxNode? = nil
            for child in node.GetChildren() {
                let childSpan = child.Span
                if childSpan.Start <= span.Start && span.End <= childSpan.End && childSpan.Length > 0 {
                    next = child
                    break
                }
            }
            if next == nil {
                return false
            }
            node = next
        }
        return false
    }

    private func Keys(diagnostics IEnumerable[Diagnostic]) HashSet[string] {
        let keys = HashSet[string](StringComparer.Ordinal)
        for diagnostic in diagnostics {
            keys.Add(Key(diagnostic))
        }
        return keys
    }

    private func Key(diagnostic Diagnostic) string -> diagnostic.Id +
        "@" +
        diagnostic
        .Location
        .Span
        .Start
        .ToString() +
        ":" +
        diagnostic
        .Location
        .Span
        .Length
        .ToString()
}
