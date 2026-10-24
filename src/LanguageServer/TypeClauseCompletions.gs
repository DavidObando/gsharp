// <copyright file="TypeClauseCompletions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import System.Collections.Generic

/// Issue #713 — LSP completion polish for the `async func(...) R` (ADR-0043) and
/// `async sequence[T]` (ADR-0042) type-clause spellings.
/// @remarks The two forms only make sense in a type-clause position (parameter / local / field /
/// return type / generic argument / etc.). The detector here piggy-backs on the syntax
/// tree the parser already produced: it walks down from the root looking for the
/// deepest (cref:TypeClauseSyntax) that brackets the caret offset, plus a small
/// set of "type-clause-bearing" parents whose type slot is currently empty (the user
/// hasn't typed anything yet — e.g. `let x |`, `func foo(p |)`,
/// `func foo() |`). This piggy-backs on the parser's own type-clause shapes
/// instead of duplicating the start-of-type-clause set.
internal shared class TypeClauseCompletions {
    /// Snippet label for the canonical async arrow-form function-type clause `async (...) -> R` (ADR-0075).
    const AsyncFuncLabel string = "async (...) -> R"

    /// Snippet label for the `async sequence[T]` form (ADR-0042).
    const AsyncSequenceLabel string = "async sequence[T]"

    /// Markdown body rendered as (cref:CompletionItem.Documentation) for the
    /// async-arrow function-type snippet, and reused by (cref:HoverComputer) when
    /// hovering the `async` / `->` tokens of an async function-type clause
    /// (or the legacy `func` keyword while the deprecation window is open).
    const AsyncFuncDocumentation string = "**`async (P) -> R`** — function-type spelling for `(P) -> Task[R]` (ADR-0043 / ADR-0075).\n\n" +
        "In any type-clause position, `async (P1, P2, ...) -> R` resolves to the same `FunctionTypeSymbol` as the explicit " +
        "`(P1, P2, ...) -> Task[R]` spelling — the two are freely interchangeable. " +
        "Use this form to match the `async func foo() R` declaration shape at consumer sites (parameters, locals, fields, " +
        "return types). The return-slot wrap mirrors the declaration-site rules of ADR-0023; writing `Task[X]` explicitly " +
        "inside an `async (...) -> R` is a diagnostic (GS0189) because the modifier already implies it.\n\n" +
        "Special-case follower: `async sequence[T]` resolves to `IAsyncEnumerable[T]` (ADR-0042).\n\n" +
        "The legacy spelling `async func(P) R` is still accepted in this release but emits the deprecation " +
        "warning GS0303 (ADR-0075); use the arrow form above instead."

    /// Markdown body rendered as (cref:CompletionItem.Documentation) for the
    /// `async sequence` snippet, and reused by (cref:HoverComputer) when
    /// hovering the `async`/`sequence` tokens of an async sequence type clause.
    const AsyncSequenceDocumentation string = "**`async sequence[T]`** — type-clause spelling for `IAsyncEnumerable[T]` (ADR-0042).\n\n" +
        "In any type-clause position, `async sequence[T]` resolves to `System.Collections.Generic.IAsyncEnumerable<T>` — " +
        "the same `AsyncSequenceTypeSymbol` produced by the ADR-0041 implicit-swap in an async iterator's return slot. " +
        "Use this form at consumer sites (parameters, locals, fields, generic arguments) to keep a GSharp-flavored spelling " +
        "instead of dropping to the BCL `IAsyncEnumerable[T]` name.\n\n" +
        "`async` as a type-clause prefix is only legal before `sequence[T]` (ADR-0042) or `func(...)` (ADR-0043)."

    /// Sort prefix that floats both async-type snippets above keyword and global-symbol
    /// items in a type-clause position. LSP sorts ascending by (cref:CompletionItem.SortText);
    /// the leading zeros keep them ahead of identifier names.
    private const SortPrefix string = "00"

    /// Adds the `async func(...) R` and `async sequence[T]` snippets to
    /// [`items`](paramref) when [`offset`](paramref) sits in a type-clause
    /// position inside [`tree`](paramref). No-op outside type-clause positions.
    /// @param items The completion-item list being built.
    /// @param seen The label-deduplication set shared with the caller.
    /// @param tree The syntax tree to inspect.
    /// @param offset The caret offset.
    /// @returns `true` when the caret is in a type-clause position and snippets were appended (or were
    /// already present).
    func TryAddTypeClauseSnippets(
        items List[CompletionItem],
        seen HashSet[string],
        tree SyntaxTree,
        offset int32
    ) bool {
        if !IsInTypeClausePosition(tree, offset) {
            return false
        }
        AddSnippet(items, seen, AsyncFuncLabel, BuildAsyncFuncSnippet(), AsyncFuncDocumentation, "01")
        AddSnippet(items, seen, AsyncSequenceLabel, BuildAsyncSequenceSnippet(), AsyncSequenceDocumentation, "02")
        AddSnippet(
            items,
            seen,
            "bytestring",
            "bytestring",
            "Immutable arbitrary bytes with byte indexing and content equality; distinct from CLR string.",
            "03"
        )
        AddSnippet(
            items,
            seen,
            "slice[T]",
            "slice[$${1:T}]",
            "Shared managed-array view with independent length and capacity.",
            "03"
        )
        AddSnippet(items, seen, "managed[T]", "managed[$${1:T}]", "Writable heap-storable managed location.", "03")
        AddSnippet(items, seen, "span[T]", "span[$${1:T}]", "CLR System.Span<T>; stack-only writable view.", "03")
        AddSnippet(
            items,
            seen,
            "readonly span[T]",
            "readonly span[$${1:T}]",
            "CLR System.ReadOnlySpan<T>; stack-only readonly view.",
            "04"
        )
        AddSnippet(
            items,
            seen,
            "readonly managed[T]",
            "readonly managed[$${1:T}]",
            "Readonly heap-storable managed location.",
            "04"
        )
        AddSnippet(
            items,
            seen,
            "readonly slice[T]",
            "readonly slice[$${1:T}]",
            "Shared native slice with readonly element access.",
            "04"
        )
        AddSnippet(
            items,
            seen,
            "array[T]",
            "array[$${1:T}]",
            "Exact CLR array; identical to []T, including copying ranges.",
            "05"
        )
        return true
    }

    /// Returns `true` when the caret at [`offset`](paramref) sits in a position
    /// where the parser would parse a (cref:TypeClauseSyntax).
    /// @remarks Two cases qualify:
    /// - the deepest syntax node containing the offset is (or is inside) a (cref:TypeClauseSyntax); OR
    /// - the offset sits in the *empty* type-clause slot of a parent that expects one — between the
    /// identifier and the `=` of a variable declaration, between a function's `)` and its body brace, etc.
    /// @param tree The syntax tree to inspect.
    /// @param offset The caret offset.
    /// @returns `true` when the caret sits in a type-clause position.
    func IsInTypeClausePosition(tree SyntaxTree, offset int32) bool {
        // First: deepest enclosing TypeClauseSyntax (the populated case — the user has
        // typed something parsable into the type slot, even if it's just `async `).
        if FindEnclosingTypeClause(tree.Root, offset) != nil {
            return true
        }
        // Second: empty type-slot of a known type-clause-bearing parent.
        for node in EnumerateNodesContaining(tree.Root, offset) {
            if IsCaretInEmptyTypeSlot(node, offset) {
                return true
            }
        }
        return false
    }

    /// Returns the deepest (cref:TypeClauseSyntax) in [`root`](paramref) whose
    /// span brackets [`offset`](paramref), or `null` when the caret is not inside
    /// a type clause. Used by hover to render ADR-rooted docs on `async` and the
    /// following keyword token.
    /// @param root The root node to walk.
    /// @param offset The caret offset.
    /// @returns The deepest enclosing type clause, or `null`.
    func FindEnclosingTypeClause(root SyntaxNode, offset int32) TypeClauseSyntax? {
        var best TypeClauseSyntax? = nil
        for node in EnumerateAllNodes(root) {
            if node is not TypeClauseSyntax typeClause {
                continue
            }
            if typeClause.Span.Start <= offset && offset <= typeClause.Span.End {
                if best == nil || typeClause.Span.Length < best.Span.Length {
                    best = typeClause
                }
            }
        }
        return best
    }

    /// Builds the LSP snippet for `async func(T) R` (ADR-0043). The snippet
    /// expands to a syntactically-valid type clause when accepted; placeholders
    /// `${1:T}` and `${2:R}` are tab-stops for the user.
    /// @returns The snippet body.
    func BuildAsyncFuncSnippet() string -> "async ($${1:T}) -> $${2:R}"

    /// Builds the LSP snippet for `async sequence[T]` (ADR-0042).
    /// @returns The snippet body.
    func BuildAsyncSequenceSnippet() string -> "async sequence[$${1:T}]"

    private func IsCaretInEmptyTypeSlot(node SyntaxNode, offset int32) bool {
        switch node {
            case variable is VariableDeclarationSyntax when variable.TypeClause == nil {
                // `let x |` (no type, no equals yet) or `let x | = ...`. The type slot lives
                // between the identifier and either the equals token or the end of the decl.
                return IsBetween(
                    variable.Identifier?.Span.End ?? -1,
                    GetEarliestEnd(variable.EqualsToken, variable.Initializer),
                    offset
                )
            }
            case parameter is ParameterSyntax when parameter.Type == nil {
                // `func foo(p |` — the type slot is between the identifier (or ellipsis) and the
                // parameter's end.
                let afterIdent = parameter.EllipsisToken?.Span.End ?? parameter.Identifier?.Span.End ?? -1
                return IsBetween(afterIdent, parameter.Span.End, offset)
            }
            case field is FieldDeclarationSyntax when field.Type == nil {
                // `var name |` inside a struct/class body.
                return IsBetween(
                    field.Identifier?.Span.End ?? -1,
                    GetEarliestEnd(field.EqualsToken, field.Initializer),
                    offset
                )
            }
            case func_ is FunctionDeclarationSyntax when func_.Type == nil {
                // `func foo() |{ ... }` — the optional return-type slot between the parameter
                // list's closing parenthesis and the body brace.
                return IsBetween(func_.CloseParenthesisToken?.Span.End ?? -1, func_.Body?.Span.Start ?? -1, offset)
            }
            default {
                return false
            }
        }
    }

    private func GetEarliestEnd(token SyntaxToken?, node SyntaxNode?) int32 {
        if token != nil && !token.IsMissing {
            return token.Span.Start
        }
        if node != nil {
            return node.Span.Start
        }
        return int32.MaxValue
    }

    private func IsBetween(startExclusiveLow int32, endInclusiveHigh int32, offset int32) bool {
        if startExclusiveLow < 0 || endInclusiveHigh < 0 || endInclusiveHigh < startExclusiveLow {
            return false
        }
        // We allow the caret to sit at either end of the slot.
        return startExclusiveLow <= offset && offset <= endInclusiveHigh
    }

    private func AddSnippet(
        items List[CompletionItem],
        seen HashSet[string],
        label string,
        snippet string,
        documentation string,
        sortKey string
    ) {
        if !seen.Add(label) {
            return
        }
        items.Add(
            CompletionItem{
                Label: label,
                Kind: CompletionItemKind.Snippet,
                Detail: "GSharp type-clause snippet",
                InsertText: snippet,
                InsertTextFormat: InsertTextFormat.Snippet,
                SortText: SortPrefix + sortKey,
                FilterText: label,
                Documentation: MarkupContent{Kind: MarkupKind.Markdown, Value: documentation}
            }
        )
    }

    private func EnumerateAllNodes(node SyntaxNode) sequence[SyntaxNode] {
        yield node
        for child in node.GetChildren() {
            if child is SyntaxToken {
                continue
            }
            for descendant in EnumerateAllNodes(child) {
                yield descendant
            }
        }
    }

    private func EnumerateNodesContaining(node SyntaxNode, offset int32) sequence[SyntaxNode] {
        if offset < node.Span.Start || offset > node.Span.End {
            yield break
        }
        yield node
        for child in node.GetChildren() {
            if child is SyntaxToken {
                continue
            }
            for descendant in EnumerateNodesContaining(child, offset) {
                yield descendant
            }
        }
    }
}
