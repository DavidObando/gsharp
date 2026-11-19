// <copyright file="SyntaxEditor.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Records text edits on the tokens and nodes of one syntax tree (ADR-0227 D1).
/// @remarks Each edit refers to the original tree. An editor never edits the result of another
/// edit. The parsed tree has no trivia, but the source text keeps it, so an edit keeps every
/// comment outside the edited span. Edits must not overlap. Two insertions at one position are
/// kept in call order.
class SyntaxEditor {
    private let edits List[RecordedEdit] = List[RecordedEdit]()
    private let placeholders List[PlaceholderMark] = List[PlaceholderMark]()

    /// Initializes a new instance of the (cref:SyntaxEditor) class.
    /// @param tree The tree to edit.
    init(tree SyntaxTree) {
        ArgumentNullException.ThrowIfNull(tree)
        OriginalTree = tree
    }

    /// Gets the tree that the edits refer to.
    prop OriginalTree SyntaxTree {
        get;
    }

    /// Gets a value that tells whether the editor has an edit.
    prop HasChanges bool -> edits.Count > 0

    /// Replaces the text of a token.
    /// @param token A real token of the original tree.
    /// @param newText The replacement text.
    func ReplaceToken(token SyntaxToken, newText string) {
        Add(RealTokenSpan(token), newText)
    }

    /// Replaces the text from the first real token to the last real token of a node.
    /// @remarks A comment inside the node is lost unless [`newText`](paramref) contains it. Use
    /// (cref:OriginalText) to keep the text of inner nodes.
    /// @param node A node of the original tree.
    /// @param newText The replacement text.
    func ReplaceNode(node SyntaxNode, newText string) {
        Add(NodeSpan(node), newText)
    }

    /// Removes a token and the spaces or tabs after it on the same line. When no space follows,
    /// the editor removes the spaces before it instead, so two words do not join.
    /// @param token A real token of the original tree.
    func RemoveToken(token SyntaxToken) {
        Add(WithHorizontalSpace(RealTokenSpan(token)), string.Empty)
    }

    /// Removes a node. When the node is alone on its lines, the editor removes those lines.
    /// Otherwise it removes the node and the spaces or tabs after it.
    /// @param node A node of the original tree.
    func RemoveNode(node SyntaxNode) {
        let span = NodeSpan(node)
        let text = OriginalTree.Text
        var lineStart = span.Start
        while lineStart > 0 && IsHorizontalSpace(text[lineStart - 1]) {
            lineStart--
        }
        var lineEnd = span.End
        while lineEnd < text.Length && IsHorizontalSpace(text[lineEnd]) {
            lineEnd++
        }
        let startsLine = lineStart == 0 || text[lineStart - 1] == '\n' || text[lineStart - 1] == '\r'
        let endsLine = lineEnd == text.Length || text[lineEnd] == '\n' || text[lineEnd] == '\r'
        if startsLine && endsLine {
            if lineEnd < text.Length && text[lineEnd] == '\r' {
                lineEnd++
            }
            if lineEnd < text.Length && text[lineEnd] == '\n' {
                lineEnd++
            }
            Add(TextSpan.FromBounds(lineStart, lineEnd), string.Empty)
            return
        }
        Add(WithHorizontalSpace(span), string.Empty)
    }

    /// Inserts text immediately before the first real token of a node or token.
    /// @param node A node or token of the original tree.
    /// @param text The text to insert.
    func InsertBefore(node SyntaxNode, text string) {
        Add(TextSpan(NodeSpan(node).Start, 0), text)
    }

    /// Inserts text immediately after the last real token of a node or token.
    /// @param node A node or token of the original tree.
    /// @param text The text to insert.
    func InsertAfter(node SyntaxNode, text string) {
        Add(TextSpan(NodeSpan(node).End, 0), text)
    }

    /// Marks part of the new text of the last edit as a placeholder that the user must replace.
    /// @param start The offset of the placeholder in the new text of the last edit.
    /// @param length The length of the placeholder.
    func MarkPlaceholder(start int32, length int32) {
        if edits.Count == 0 {
            throw InvalidOperationException("A placeholder needs an edit.")
        }
        let last = edits[edits.Count - 1]
        if start < 0 || length < 0 || start + length > last.Change.NewText.Length {
            throw ArgumentOutOfRangeException(nameof(start))
        }
        placeholders.Add(PlaceholderMark(last, start, length))
    }

    /// Gets the source text of a node, from its first real token to its last real token. The text
    /// keeps the comments and line breaks inside the node.
    /// @param node A node of the original tree.
    /// @returns The original text.
    func OriginalText(node SyntaxNode) string -> OriginalTree.Text.ToString(NodeSpan(node))

    /// Gets the recorded changes, in position order. Insertions at one position keep call order.
    /// @returns The changes.
    func GetChanges() ImmutableArray[TextChange] -> Ordered().Select((e RecordedEdit) -> e.Change).ToImmutableArray()

    /// Gets the placeholder spans in the changed text, in position order.
    /// @returns The spans.
    func GetPlaceholders() ImmutableArray[TextSpan] {
        if placeholders.Count == 0 {
            return ImmutableArray[TextSpan].Empty
        }
        let result = List[TextSpan]()
        var delta = 0
        for edit in Ordered() {
            let newStart = edit.Change.Span.Start + delta
            for mark in placeholders {
                if object.ReferenceEquals(mark.Edit, edit) {
                    result.Add(TextSpan(newStart + mark.Start, mark.Length))
                }
            }
            delta += edit.Change.NewText.Length - edit.Change.Span.Length
        }
        return result.ToImmutableArray()
    }

    /// Gets the text with the recorded changes applied.
    /// @returns The changed text.
    func GetChangedText() SourceText -> OriginalTree.Text.WithChanges(GetChanges())

    /// Parses the changed text.
    /// @returns The new tree.
    func GetChangedTree() SyntaxTree -> SyntaxTree.Parse(GetChangedText())

    private func Ordered() sequence[RecordedEdit] -> edits.OrderBy((e RecordedEdit) -> e.Change.Span.Start).ThenBy(
        (e RecordedEdit) -> e.Order
    )

    private func Add(span TextSpan, newText string) {
        ArgumentNullException.ThrowIfNull(newText)
        for existing in edits {
            if Overlaps(existing.Change.Span, span) {
                throw InvalidOperationException(
                    "The edit at ${span} overlaps the edit at ${existing.Change.Span} (ADR-0227 D1)."
                )
            }
        }
        edits.Add(RecordedEdit(TextChange(span, newText), edits.Count))
    }

    private func RealTokenSpan(token SyntaxToken) TextSpan {
        ArgumentNullException.ThrowIfNull(token)
        RequireOwnTree(token)
        if token.IsMissing || token.IsSynthesized || token.Span.Length == 0 {
            throw InvalidOperationException(
                "The token '${token.Kind}' at ${token.Position} has no source text. Edit a real token (ADR-0227 D1)."
            )
        }
        return token.Span
    }

    private func NodeSpan(node SyntaxNode) TextSpan {
        ArgumentNullException.ThrowIfNull(node)
        RequireOwnTree(node)
        if node is SyntaxToken token {
            return RealTokenSpan(token)
        }
        return node.Span
    }

    private func RequireOwnTree(node SyntaxNode) {
        if !object.ReferenceEquals(node.SyntaxTree, OriginalTree) {
            throw ArgumentException("The node is not in the tree of this editor.", nameof(node))
        }
    }

    private func WithHorizontalSpace(span TextSpan) TextSpan {
        let text = OriginalTree.Text
        var end = span.End
        while end < text.Length && IsHorizontalSpace(text[end]) {
            end++
        }
        if end > span.End {
            return TextSpan.FromBounds(span.Start, end)
        }
        var start = span.Start
        while start > 0 && IsHorizontalSpace(text[start - 1]) {
            start--
        }
        return TextSpan.FromBounds(start, span.End)
    }

    shared {
        // Two changes overlap when they share a character, or when an insertion is strictly
        // inside a replaced span. Insertions at one position, and an insertion at the edge of a
        // replacement, do not overlap.
        private func Overlaps(a TextSpan, b TextSpan) bool {
            if a.Length == 0 && b.Length == 0 {
                return false
            }
            if a.Length == 0 {
                return b.Start < a.Start && a.Start < b.End
            }
            if b.Length == 0 {
                return a.Start < b.Start && b.Start < a.End
            }
            return a.Start < b.End && b.Start < a.End
        }

        private func IsHorizontalSpace(c char) bool -> c == ' ' || c == '\t'
    }

    private class RecordedEdit {
        init(change TextChange, order int32) {
            Change = change
            Order = order
        }

        prop Change TextChange {
            get;
        }

        prop Order int32 {
            get;
        }
    }

    private class PlaceholderMark {
        init(edit RecordedEdit, start int32, length int32) {
            Edit = edit
            Start = start
            Length = length
        }

        prop Edit RecordedEdit {
            get;
        }

        prop Start int32 {
            get;
        }

        prop Length int32 {
            get;
        }
    }
}
