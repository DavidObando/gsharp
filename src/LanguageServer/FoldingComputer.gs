// <copyright file="FoldingComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import System.Collections.Generic
import System.Linq
import System.Threading

/// Pure-function folding range computer that the language server and tests can both use
/// without needing an LSP transport.
shared class FoldingComputer {
    /// Computes folding ranges for every multi-line, brace-delimited region in the document.
    /// @remarks The computer walks the full syntax tree (via (cref:SyntaxNode.GetChildren)) rather
    /// than only the root members, and emits one region per node that directly owns a matching
    /// `{`/`}` pair. That single rule covers, at any nesting depth:
    /// - block statements — function, constructor, and deinitializer bodies, property and event accessor
    /// bodies, and the bodies of `if`/`else`, `for` (all variants), `while`, `do`/`while`, `scope`,
    /// `fixed`, `using`, and the `try`/`catch`/`finally` blocks;
    /// - type declarations — `struct`/`class`, `interface`, and `enum`, as well as `shared` blocks;
    /// - property and event declarations; and
    /// - `switch` and `select` statements.
    /// Body-less members (extern/P-Invoke functions, `;`-bodied members, interface method
    /// stubs) expose no brace pair and are naturally skipped. A range is only emitted when it
    /// spans more than one line, so single-line blocks never produce a degenerate fold. Results
    /// are de-duplicated and returned in source order, keeping the function deterministic for a
    /// given (cref:DocumentContent).
    /// @param content The document content to compute folding ranges for.
    /// @param ct Token checked between tree nodes so a superseded request aborts a large-file walk.
    /// @returns The folding ranges, ordered by start line then end line.
    func ComputeFoldings(content DocumentContent, ct CancellationToken = default(CancellationToken)) IEnumerable[
        FoldingRange
    ] {
        let seen = HashSet[(StartLine int32, EndLine int32)]()
        let ranges = List[FoldingRange]()
        for node in DescendantNodesAndSelf(content.SyntaxTree.Root) {
            ct.ThrowIfCancellationRequested()
            let range_ FoldingRange? = TryComputeBraceFold(node, content)
            if range_ != nil && seen.Add((range_.StartLine, range_.EndLine)) {
                ranges.Add(range_)
            }
        }
        ranges.Sort(
            (left FoldingRange, right FoldingRange) -> {
                let byStart = left.StartLine.CompareTo(right.StartLine)
                return if byStart != 0 {
                    byStart
                } else {
                    left.EndLine.CompareTo(right.EndLine)
                }
            }
        )
        return ranges
    }

    private func DescendantNodesAndSelf(root SyntaxNode) sequence[SyntaxNode] {
        let stack = Stack[SyntaxNode]()
        stack.Push(root)
        while stack.Count > 0 {
            let node = stack.Pop()
            yield node
            for child in node.GetChildren().Reverse() {
                stack.Push(child)
            }
        }
    }

    private func TryComputeBraceFold(node SyntaxNode, content DocumentContent) FoldingRange? {
        var openBrace SyntaxToken? = nil
        var closeBrace SyntaxToken? = nil
        for child in node.GetChildren() {
            if child is not SyntaxToken token {
                continue
            }
            if token.Kind == SyntaxKind.OpenBraceToken {
                openBrace ??= token
            } else if token.Kind == SyntaxKind.CloseBraceToken {
                closeBrace = token
            }
        }
        if openBrace == nil || closeBrace == nil {
            return nil
        }
        let startLine = content.Lines.Count((offset int32) -> offset < openBrace!!.Span.Start)
        let endLine = content.Lines.Count((offset int32) -> offset < closeBrace!!.Span.End)
        if endLine <= startLine {
            return nil
        }
        return FoldingRange{
            StartLine: startLine,
            EndLine: endLine,
            Kind: FoldingRangeKind.Region,
            EndCharacter: 0,
            StartCharacter: 0
        }
    }
}
