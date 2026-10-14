// <copyright file="SelectionRangeComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System.Collections.Generic

/// Pure-function selection range computer.
shared class SelectionRangeComputer {
    func ComputeSelectionRange(content DocumentContent, position Position) SelectionRange {
        let tree = content.SyntaxTree
        let text = tree.Text
        let offset = SemanticLookup.ToOffset(content, position)
        // Find all enclosing nodes from innermost to outermost
        let chain = List[SyntaxNode]()
        CollectAncestors(tree.Root, offset, chain)
        // Build nested SelectionRange from inside out
        var current SelectionRange? = nil
        for var i = chain.Count - 1; i >= 0; i-- {
            let node = chain[i]
            let range_ = SemanticLookup.ToRange(text, node.Span)
            current = SelectionRange{Range: range_, Parent: current}
        }
        // If no chain found, return a range for the whole file
        if current == nil {
            let lastLine = text.Lines.Length - 1
            let lastChar = text.Lines[lastLine].Length
            current = SelectionRange{Range: Range(Position(0, 0), Position(lastLine, lastChar))}
        }
        return current
    }

    private func CollectAncestors(node SyntaxNode, offset int32, chain List[SyntaxNode]) {
        if node.Span.Start > offset || node.Span.End < offset {
            return
        }
        // Add this node to the chain (outermost first, will reverse order in consumer)
        chain.Add(node)
        for child in node.GetChildren() {
            if child.Span.Start <= offset && offset <= child.Span.End {
                CollectAncestors(child, offset, chain)
                return
            }
        }
    }
}
