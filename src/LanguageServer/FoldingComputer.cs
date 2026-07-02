// <copyright file="FoldingComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function folding range computer that the language server and tests can both use
/// without needing an LSP transport.
/// </summary>
public static class FoldingComputer
{
    /// <summary>
    /// Computes folding ranges for every multi-line, brace-delimited region in the document.
    /// </summary>
    /// <remarks>
    /// The computer walks the full syntax tree (via <see cref="SyntaxNode.GetChildren"/>) rather
    /// than only the root members, and emits one region per node that directly owns a matching
    /// <c>{</c>/<c>}</c> pair. That single rule covers, at any nesting depth:
    /// <list type="bullet">
    /// <item>block statements — function, constructor, and deinitializer bodies, property and
    /// event accessor bodies, and the bodies of <c>if</c>/<c>else</c>, <c>for</c> (all variants),
    /// <c>while</c>, <c>do</c>/<c>while</c>, <c>scope</c>, <c>fixed</c>, <c>using</c>, and the
    /// <c>try</c>/<c>catch</c>/<c>finally</c> blocks;</item>
    /// <item>type declarations — <c>struct</c>/<c>class</c>, <c>interface</c>, and <c>enum</c>, as
    /// well as <c>shared</c> blocks;</item>
    /// <item>property and event declarations; and</item>
    /// <item><c>switch</c> and <c>select</c> statements.</item>
    /// </list>
    /// Body-less members (extern/P-Invoke functions, <c>;</c>-bodied members, interface method
    /// stubs) expose no brace pair and are naturally skipped. A range is only emitted when it
    /// spans more than one line, so single-line blocks never produce a degenerate fold. Results
    /// are de-duplicated and returned in source order, keeping the function deterministic for a
    /// given <see cref="DocumentContent"/>.
    /// </remarks>
    /// <param name="content">The document content to compute folding ranges for.</param>
    /// <param name="ct">Token checked between tree nodes so a superseded request aborts a large-file walk.</param>
    /// <returns>The folding ranges, ordered by start line then end line.</returns>
    public static IEnumerable<FoldingRange> ComputeFoldings(DocumentContent content, CancellationToken ct = default)
    {
        var seen = new HashSet<(int StartLine, int EndLine)>();
        var ranges = new List<FoldingRange>();

        foreach (SyntaxNode node in DescendantNodesAndSelf(content.SyntaxTree.Root))
        {
            ct.ThrowIfCancellationRequested();
            FoldingRange range = TryComputeBraceFold(node, content);
            if (range != null && seen.Add((range.StartLine, range.EndLine)))
            {
                ranges.Add(range);
            }
        }

        ranges.Sort((left, right) =>
        {
            int byStart = left.StartLine.CompareTo(right.StartLine);
            return byStart != 0 ? byStart : left.EndLine.CompareTo(right.EndLine);
        });

        return ranges;
    }

    private static IEnumerable<SyntaxNode> DescendantNodesAndSelf(SyntaxNode root)
    {
        var stack = new Stack<SyntaxNode>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            SyntaxNode node = stack.Pop();
            yield return node;

            foreach (SyntaxNode child in node.GetChildren().Reverse())
            {
                stack.Push(child);
            }
        }
    }

    private static FoldingRange TryComputeBraceFold(SyntaxNode node, DocumentContent content)
    {
        SyntaxToken openBrace = null;
        SyntaxToken closeBrace = null;

        foreach (SyntaxNode child in node.GetChildren())
        {
            if (child is not SyntaxToken token)
            {
                continue;
            }

            if (token.Kind == SyntaxKind.OpenBraceToken)
            {
                openBrace ??= token;
            }
            else if (token.Kind == SyntaxKind.CloseBraceToken)
            {
                closeBrace = token;
            }
        }

        if (openBrace == null || closeBrace == null)
        {
            return null;
        }

        int startLine = content.Lines.Count(offset => offset < openBrace.Span.Start);
        int endLine = content.Lines.Count(offset => offset < closeBrace.Span.End);
        if (endLine <= startLine)
        {
            return null;
        }

        return new FoldingRange
        {
            StartLine = startLine,
            EndLine = endLine,
            Kind = FoldingRangeKind.Region,
            EndCharacter = 0,
            StartCharacter = 0,
        };
    }
}
