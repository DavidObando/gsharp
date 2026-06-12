// <copyright file="TypeClauseCompletions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;

namespace GSharp.LanguageServer;

/// <summary>
/// Issue #713 — LSP completion polish for the <c>async func(...) R</c> (ADR-0043) and
/// <c>async sequence[T]</c> (ADR-0042) type-clause spellings.
/// </summary>
/// <remarks>
/// The two forms only make sense in a type-clause position (parameter / local / field /
/// return type / generic argument / etc.). The detector here piggy-backs on the syntax
/// tree the parser already produced: it walks down from the root looking for the
/// deepest <see cref="TypeClauseSyntax"/> that brackets the caret offset, plus a small
/// set of "type-clause-bearing" parents whose type slot is currently empty (the user
/// hasn't typed anything yet — e.g. <c>let x |</c>, <c>func foo(p |)</c>,
/// <c>func foo() |</c>). This piggy-backs on the parser's own type-clause shapes
/// instead of duplicating the start-of-type-clause set.
/// </remarks>
internal static class TypeClauseCompletions
{
    /// <summary>Snippet label for the <c>async func(...) R</c> form (ADR-0043).</summary>
    public const string AsyncFuncLabel = "async func(...) R";

    /// <summary>Snippet label for the <c>async sequence[T]</c> form (ADR-0042).</summary>
    public const string AsyncSequenceLabel = "async sequence[T]";

    /// <summary>
    /// Markdown body rendered as <see cref="CompletionItem.Documentation"/> for the
    /// <c>async func</c> snippet, and reused by <see cref="HoverComputer"/> when hovering
    /// the <c>async</c>/<c>func</c> tokens of an async function-type clause.
    /// </summary>
    public const string AsyncFuncDocumentation =
        "**`async func(P) R`** — function-type spelling for `func(P) Task[R]` (ADR-0043).\n\n" +
        "In any type-clause position, `async func(P1, P2, ...) R` resolves to the same `FunctionTypeSymbol` as the explicit " +
        "`func(P1, P2, ...) Task[R]` spelling — the two are freely interchangeable. " +
        "Use this form to match the `async func foo() R` declaration shape at consumer sites (parameters, locals, fields, " +
        "return types). The return-slot wrap mirrors the declaration-site rules of ADR-0023; writing `Task[X]` explicitly " +
        "inside an `async func(...)` is a diagnostic (GS0189) because the modifier already implies it.\n\n" +
        "Special-case follower: `async sequence[T]` resolves to `IAsyncEnumerable[T]` (ADR-0042).";

    /// <summary>
    /// Markdown body rendered as <see cref="CompletionItem.Documentation"/> for the
    /// <c>async sequence</c> snippet, and reused by <see cref="HoverComputer"/> when
    /// hovering the <c>async</c>/<c>sequence</c> tokens of an async sequence type clause.
    /// </summary>
    public const string AsyncSequenceDocumentation =
        "**`async sequence[T]`** — type-clause spelling for `IAsyncEnumerable[T]` (ADR-0042).\n\n" +
        "In any type-clause position, `async sequence[T]` resolves to `System.Collections.Generic.IAsyncEnumerable<T>` — " +
        "the same `AsyncSequenceTypeSymbol` produced by the ADR-0041 implicit-swap in an async iterator's return slot. " +
        "Use this form at consumer sites (parameters, locals, fields, generic arguments) to keep a GSharp-flavored spelling " +
        "instead of dropping to the BCL `IAsyncEnumerable[T]` name.\n\n" +
        "`async` as a type-clause prefix is only legal before `sequence[T]` (ADR-0042) or `func(...)` (ADR-0043).";

    /// <summary>
    /// Sort prefix that floats both async-type snippets above keyword and global-symbol
    /// items in a type-clause position. LSP sorts ascending by <see cref="CompletionItem.SortText"/>;
    /// the leading zeros keep them ahead of identifier names.
    /// </summary>
    private const string SortPrefix = "00";

    /// <summary>
    /// Adds the <c>async func(...) R</c> and <c>async sequence[T]</c> snippets to
    /// <paramref name="items"/> when <paramref name="offset"/> sits in a type-clause
    /// position inside <paramref name="tree"/>. No-op outside type-clause positions.
    /// </summary>
    /// <param name="items">The completion-item list being built.</param>
    /// <param name="seen">The label-deduplication set shared with the caller.</param>
    /// <param name="tree">The syntax tree to inspect.</param>
    /// <param name="offset">The caret offset.</param>
    /// <returns><c>true</c> when the caret is in a type-clause position and snippets were appended (or were already present).</returns>
    public static bool TryAddTypeClauseSnippets(
        List<CompletionItem> items,
        HashSet<string> seen,
        SyntaxTree tree,
        int offset)
    {
        if (!IsInTypeClausePosition(tree, offset))
        {
            return false;
        }

        AddSnippet(items, seen, AsyncFuncLabel, BuildAsyncFuncSnippet(), AsyncFuncDocumentation, "01");
        AddSnippet(items, seen, AsyncSequenceLabel, BuildAsyncSequenceSnippet(), AsyncSequenceDocumentation, "02");
        return true;
    }

    /// <summary>
    /// Returns <c>true</c> when the caret at <paramref name="offset"/> sits in a position
    /// where the parser would parse a <see cref="TypeClauseSyntax"/>.
    /// </summary>
    /// <remarks>
    /// Two cases qualify:
    /// <list type="bullet">
    ///   <item>the deepest syntax node containing the offset is (or is inside) a <see cref="TypeClauseSyntax"/>; OR</item>
    ///   <item>the offset sits in the *empty* type-clause slot of a parent that expects one — between the identifier and the
    ///         <c>=</c> of a variable declaration, between a function's <c>)</c> and its body brace, etc.</item>
    /// </list>
    /// </remarks>
    /// <param name="tree">The syntax tree to inspect.</param>
    /// <param name="offset">The caret offset.</param>
    /// <returns><c>true</c> when the caret sits in a type-clause position.</returns>
    public static bool IsInTypeClausePosition(SyntaxTree tree, int offset)
    {
        // First: deepest enclosing TypeClauseSyntax (the populated case — the user has
        // typed something parsable into the type slot, even if it's just `async `).
        if (FindEnclosingTypeClause(tree.Root, offset) != null)
        {
            return true;
        }

        // Second: empty type-slot of a known type-clause-bearing parent.
        foreach (var node in EnumerateNodesContaining(tree.Root, offset))
        {
            if (IsCaretInEmptyTypeSlot(node, offset))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns the deepest <see cref="TypeClauseSyntax"/> in <paramref name="root"/> whose
    /// span brackets <paramref name="offset"/>, or <c>null</c> when the caret is not inside
    /// a type clause. Used by hover to render ADR-rooted docs on <c>async</c> and the
    /// following keyword token.
    /// </summary>
    /// <param name="root">The root node to walk.</param>
    /// <param name="offset">The caret offset.</param>
    /// <returns>The deepest enclosing type clause, or <c>null</c>.</returns>
    public static TypeClauseSyntax FindEnclosingTypeClause(SyntaxNode root, int offset)
    {
        TypeClauseSyntax best = null;
        foreach (var node in EnumerateAllNodes(root))
        {
            if (node is not TypeClauseSyntax typeClause)
            {
                continue;
            }

            if (typeClause.Span.Start <= offset && offset <= typeClause.Span.End)
            {
                if (best == null || typeClause.Span.Length < best.Span.Length)
                {
                    best = typeClause;
                }
            }
        }

        return best;
    }

    /// <summary>
    /// Builds the LSP snippet for <c>async func(T) R</c> (ADR-0043). The snippet
    /// expands to a syntactically-valid type clause when accepted; placeholders
    /// <c>${1:T}</c> and <c>${2:R}</c> are tab-stops for the user.
    /// </summary>
    /// <returns>The snippet body.</returns>
    public static string BuildAsyncFuncSnippet() => "async func(${1:T}) ${2:R}";

    /// <summary>
    /// Builds the LSP snippet for <c>async sequence[T]</c> (ADR-0042).
    /// </summary>
    /// <returns>The snippet body.</returns>
    public static string BuildAsyncSequenceSnippet() => "async sequence[${1:T}]";

    private static bool IsCaretInEmptyTypeSlot(SyntaxNode node, int offset)
    {
        switch (node)
        {
            case VariableDeclarationSyntax variable when variable.TypeClause == null:
                // `let x |` (no type, no equals yet) or `let x | = ...`. The type slot lives
                // between the identifier and either the equals token or the end of the decl.
                return IsBetween(variable.Identifier?.Span.End ?? -1, GetEarliestEnd(variable.EqualsToken, variable.Initializer), offset);

            case ParameterSyntax parameter when parameter.Type == null:
                // `func foo(p |` — the type slot is between the identifier (or ellipsis) and the
                // parameter's end.
                var afterIdent = parameter.EllipsisToken?.Span.End ?? parameter.Identifier?.Span.End ?? -1;
                return IsBetween(afterIdent, parameter.Span.End, offset);

            case FieldDeclarationSyntax field when field.Type == null:
                // `var name |` inside a struct/class body.
                return IsBetween(field.Identifier?.Span.End ?? -1, GetEarliestEnd(field.EqualsToken, field.Initializer), offset);

            case FunctionDeclarationSyntax func when func.Type == null:
                // `func foo() |{ ... }` — the optional return-type slot between the parameter
                // list's closing parenthesis and the body brace.
                return IsBetween(func.CloseParenthesisToken?.Span.End ?? -1, func.Body?.Span.Start ?? -1, offset);

            default:
                return false;
        }
    }

    private static int GetEarliestEnd(SyntaxToken token, SyntaxNode node)
    {
        if (token != null && !token.IsMissing)
        {
            return token.Span.Start;
        }

        if (node != null)
        {
            return node.Span.Start;
        }

        return int.MaxValue;
    }

    private static bool IsBetween(int startExclusiveLow, int endInclusiveHigh, int offset)
    {
        if (startExclusiveLow < 0 || endInclusiveHigh < 0 || endInclusiveHigh < startExclusiveLow)
        {
            return false;
        }

        // We allow the caret to sit at either end of the slot.
        return startExclusiveLow <= offset && offset <= endInclusiveHigh;
    }

    private static void AddSnippet(
        List<CompletionItem> items,
        HashSet<string> seen,
        string label,
        string snippet,
        string documentation,
        string sortKey)
    {
        if (!seen.Add(label))
        {
            return;
        }

        items.Add(new CompletionItem
        {
            Label = label,
            Kind = CompletionItemKind.Snippet,
            Detail = "GSharp type-clause snippet",
            InsertText = snippet,
            InsertTextFormat = InsertTextFormat.Snippet,
            SortText = SortPrefix + sortKey,
            FilterText = "async",
            Documentation = new MarkupContent
            {
                Kind = MarkupKind.Markdown,
                Value = documentation,
            },
        });
    }

    private static IEnumerable<SyntaxNode> EnumerateAllNodes(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken)
            {
                continue;
            }

            foreach (var descendant in EnumerateAllNodes(child))
            {
                yield return descendant;
            }
        }
    }

    private static IEnumerable<SyntaxNode> EnumerateNodesContaining(SyntaxNode node, int offset)
    {
        if (offset < node.Span.Start || offset > node.Span.End)
        {
            yield break;
        }

        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken)
            {
                continue;
            }

            foreach (var descendant in EnumerateNodesContaining(child, offset))
            {
                yield return descendant;
            }
        }
    }
}
