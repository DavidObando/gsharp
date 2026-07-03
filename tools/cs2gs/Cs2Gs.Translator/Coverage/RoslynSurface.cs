// <copyright file="RoslynSurface.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Translator.Coverage;

/// <summary>
/// Enumerates the C# language surface cs2gs must account for: every Roslyn
/// <see cref="SyntaxKind"/> that identifies a syntax <em>node</em> (tokens and
/// unstructured trivia are excluded; preprocessor-directive and
/// documentation-comment structures are kept — their exclusion from translation
/// is a deliberate, recorded classification, not an invisible filter), plus the
/// concrete <see cref="CSharpSyntaxNode"/> classes as a second drift axis.
/// The snapshot text is golden-tested (ConstructInventoryGoldenTests) so a
/// Roslyn upgrade that adds kinds fails the build until the new constructs are
/// classified in the construct inventory.
/// </summary>
public static class RoslynSurface
{
    /// <summary>
    /// Gets the <see cref="SyntaxKind"/> names that identify syntax nodes, in
    /// ordinal order. This is the key set of the construct inventory.
    /// </summary>
    /// <returns>The sorted node-kind names.</returns>
    public static IReadOnlyList<string> NodeKindNames()
    {
        var names = new List<string>();
        foreach (SyntaxKind kind in Enum.GetValues<SyntaxKind>())
        {
            if (IsNodeKind(kind))
            {
                names.Add(kind.ToString());
            }
        }

        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>
    /// Gets the concrete (non-abstract, public) <see cref="CSharpSyntaxNode"/>
    /// class names, in ordinal order. A new Roslyn node class fails the golden
    /// even if the kind filter were mis-edited.
    /// </summary>
    /// <returns>The sorted node-class names.</returns>
    public static IReadOnlyList<string> NodeClassNames()
    {
        return typeof(CSharpSyntaxNode).Assembly
            .GetExportedTypes()
            .Where(type => !type.IsAbstract && typeof(CSharpSyntaxNode).IsAssignableFrom(type))
            .Select(type => type.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>
    /// Builds the canonical Roslyn-surface snapshot compared against
    /// <c>roslyn-surface.golden.txt</c>. The header pins the Roslyn assembly
    /// version so a package bump alone is visible in the diff.
    /// </summary>
    /// <returns>The snapshot text, LF-normalized.</returns>
    public static string BuildSnapshot()
    {
        var sb = new StringBuilder();
        string roslynVersion = typeof(CSharpSyntaxNode).Assembly.GetName().Version?.ToString() ?? "unknown";

        sb.AppendLine("# cs2gs Roslyn-surface snapshot");
        sb.AppendLine($"# Generated from Microsoft.CodeAnalysis.CSharp {roslynVersion}:");
        sb.AppendLine("# SyntaxKind node kinds (tokens/unstructured trivia excluded) and concrete");
        sb.AppendLine("# CSharpSyntaxNode classes. Drift fails ConstructInventoryGoldenTests.");
        sb.AppendLine();

        sb.AppendLine("[NodeKinds]");
        foreach (string name in NodeKindNames())
        {
            sb.AppendLine(name);
        }

        sb.AppendLine();
        sb.AppendLine("[NodeClasses]");
        foreach (string name in NodeClassNames())
        {
            sb.AppendLine(name);
        }

        return sb.ToString().Replace("\r\n", "\n");
    }

    /// <summary>
    /// Classifies a <see cref="SyntaxKind"/> as a syntax-node kind. Tokens,
    /// keywords, punctuation, and unstructured trivia (whitespace, comments,
    /// disabled text, conflict markers, the doc-comment exterior) are not
    /// nodes; structured trivia — preprocessor directives, skipped tokens, and
    /// the documentation-comment roots — are kept so the inventory records
    /// their deliberate disposition.
    /// </summary>
    /// <param name="kind">The kind to classify.</param>
    /// <returns><see langword="true"/> when the kind identifies a syntax node.</returns>
    private static bool IsNodeKind(SyntaxKind kind)
    {
        if (kind is SyntaxKind.None or SyntaxKind.List)
        {
            return false;
        }

        if (SyntaxFacts.IsAnyToken(kind))
        {
            return false;
        }

        if (SyntaxFacts.IsTrivia(kind))
        {
            return IsStructuredTriviaNodeKind(kind);
        }

        // Unstructured trivia SyntaxFacts.IsTrivia misses: the free-text tail
        // of #error/#warning/#region lines carries no syntax node of its own.
        if (kind == SyntaxKind.PreprocessingMessageTrivia)
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// Determines whether a trivia kind carries a structured syntax node worth
    /// inventorying (a directive, skipped tokens, or a doc-comment root).
    /// </summary>
    /// <param name="kind">The trivia kind.</param>
    /// <returns><see langword="true"/> for structured trivia node kinds.</returns>
    private static bool IsStructuredTriviaNodeKind(SyntaxKind kind)
    {
        return SyntaxFacts.IsPreprocessorDirective(kind)
            || kind is SyntaxKind.SkippedTokensTrivia
                or SyntaxKind.SingleLineDocumentationCommentTrivia
                or SyntaxKind.MultiLineDocumentationCommentTrivia;
    }
}
