// <copyright file="SelectionRangeComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function selection range computer.
/// </summary>
internal static class SelectionRangeComputer
{
    public static SelectionRange ComputeSelectionRange(DocumentContent content, Position position)
    {
        var tree = content.SyntaxTree;
        var text = tree.Text;
        var offset = SemanticLookup.ToOffset(content, position);

        // Find all enclosing nodes from innermost to outermost
        var chain = new List<SyntaxNode>();
        CollectAncestors(tree.Root, offset, chain);

        // Build nested SelectionRange from inside out
        SelectionRange current = null;
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            var node = chain[i];
            var range = SemanticLookup.ToRange(text, node.Span);
            current = new SelectionRange { Range = range, Parent = current };
        }

        // If no chain found, return a range for the whole file
        if (current == null)
        {
            var lastLine = text.Lines.Length - 1;
            var lastChar = text.Lines[lastLine].Length;
            current = new SelectionRange
            {
                Range = new Range(
                    new Position(0, 0),
                    new Position(lastLine, lastChar)),
            };
        }

        return current;
    }

    private static void CollectAncestors(SyntaxNode node, int offset, List<SyntaxNode> chain)
    {
        if (node.Span.Start > offset || node.Span.End < offset)
        {
            return;
        }

        // Add this node to the chain (outermost first, will reverse order in consumer)
        chain.Add(node);

        foreach (var child in node.GetChildren())
        {
            if (child.Span.Start <= offset && offset <= child.Span.End)
            {
                CollectAncestors(child, offset, chain);
                return;
            }
        }
    }
}
