// <copyright file="RoslynSurface.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Coverage

import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import System.Text

/// Enumerates the C# language surface cs2gs must account for: every Roslyn
/// (cref:SyntaxKind) that identifies a syntax <em>node</em> (tokens and
/// unstructured trivia are excluded; preprocessor-directive and
/// documentation-comment structures are kept — their exclusion from translation
/// is a deliberate, recorded classification, not an invisible filter), plus the
/// concrete (cref:CSharpSyntaxNode) classes as a second drift axis.
/// The snapshot text is golden-tested (ConstructInventoryGoldenTests) so a
/// Roslyn upgrade that adds kinds fails the build until the new constructs are
/// classified in the construct inventory.
shared class RoslynSurface {
    /// Gets the (cref:SyntaxKind) names that identify syntax nodes, in
    /// ordinal order. This is the key set of the construct inventory.
    /// @returns The sorted node-kind names.
    func NodeKindNames() IReadOnlyList[string] {
        let names = List[string]()
        for kind in Enum.GetValues[SyntaxKind]() {
            if IsNodeKind(kind) {
                names.Add(kind.ToString())
            }
        }
        names.Sort(StringComparer.Ordinal)
        return names
    }

    /// Gets the concrete (non-abstract, public) (cref:CSharpSyntaxNode)
    /// class names, in ordinal order. A new Roslyn node class fails the golden
    /// even if the kind filter were mis-edited.
    /// @returns The sorted node-class names.
    func NodeClassNames() IReadOnlyList[string] {
        return typeof(CSharpSyntaxNode)
            .Assembly
            .GetExportedTypes()
            .Where((type Type) -> !type.IsAbstract && typeof(CSharpSyntaxNode).IsAssignableFrom(type))
            .Select((type Type) -> type.Name)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
    }

    /// Builds the canonical Roslyn-surface snapshot compared against
    /// `roslyn-surface.golden.txt`. The header pins the Roslyn assembly
    /// version so a package bump alone is visible in the diff.
    /// @returns The snapshot text, LF-normalized.
    func BuildSnapshot() string {
        let sb = StringBuilder()
        let roslynVersion = typeof(CSharpSyntaxNode).Assembly.GetName().Version?.ToString() ?? "unknown"
        sb.AppendLine("# cs2gs Roslyn-surface snapshot")
        sb.AppendLine("# Generated from Microsoft.CodeAnalysis.CSharp $roslynVersion:")
        sb.AppendLine("# SyntaxKind node kinds (tokens/unstructured trivia excluded) and concrete")
        sb.AppendLine("# CSharpSyntaxNode classes. Drift fails ConstructInventoryGoldenTests.")
        sb.AppendLine()
        sb.AppendLine("[NodeKinds]")
        for name in NodeKindNames() {
            sb.AppendLine(name)
        }
        sb.AppendLine()
        sb.AppendLine("[NodeClasses]")
        for name in NodeClassNames() {
            sb.AppendLine(name)
        }
        return sb.ToString().Replace("\r\n", "\n")
    }

    /// Classifies a (cref:SyntaxKind) as a syntax-node kind. Tokens,
    /// keywords, punctuation, and unstructured trivia (whitespace, comments,
    /// disabled text, conflict markers, the doc-comment exterior) are not
    /// nodes; structured trivia — preprocessor directives, skipped tokens, and
    /// the documentation-comment roots — are kept so the inventory records
    /// their deliberate disposition.
    /// @param kind The kind to classify.
    /// @returns `true` when the kind identifies a syntax node.
    private func IsNodeKind(kind SyntaxKind) bool {
        if kind == SyntaxKind.None || kind == SyntaxKind.List {
            return false
        }
        if SyntaxFacts.IsAnyToken(kind) {
            return false
        }
        if SyntaxFacts.IsTrivia(kind) {
            return IsStructuredTriviaNodeKind(kind)
        }
        // Unstructured trivia SyntaxFacts.IsTrivia misses: the free-text tail
        // of #error/#warning/#region lines carries no syntax node of its own.
        if kind == SyntaxKind.PreprocessingMessageTrivia {
            return false
        }
        return true
    }

    /// Determines whether a trivia kind carries a structured syntax node worth
    /// inventorying (a directive, skipped tokens, or a doc-comment root).
    /// @param kind The trivia kind.
    /// @returns `true` for structured trivia node kinds.
    private func IsStructuredTriviaNodeKind(kind SyntaxKind) bool {
        return SyntaxFacts.IsPreprocessorDirective(kind) ||
            kind == SyntaxKind.SkippedTokensTrivia ||
            kind == SyntaxKind.SingleLineDocumentationCommentTrivia ||
            kind == SyntaxKind.MultiLineDocumentationCommentTrivia
    }
}
