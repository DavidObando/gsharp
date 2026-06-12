// <copyright file="AsyncTypeClauseCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #713 — exercises the LSP completion and hover polish for the two
/// async type-clause spellings:
/// <list type="bullet">
///   <item><c>async func(...) R</c> (ADR-0043) — alias for <c>func(...) Task[R]</c>.</item>
///   <item><c>async sequence[T]</c> (ADR-0042) — alias for <c>IAsyncEnumerable[T]</c>.</item>
/// </list>
/// </summary>
public class AsyncTypeClauseCompletionTests
{
    // ---------- Completion: snippets surface in type-clause positions ----------

    [Fact]
    public void Completion_AtStartOfEmptyParameterTypeSlot_OffersBothAsyncSnippets()
    {
        // Cursor right after the parameter identifier, before any type characters have been
        // typed: `func foo(p |)`. This is the canonical "empty type-clause position".
        const string source = "func foo(p ) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "));

        AssertHasAsyncFuncSnippet(items);
        AssertHasAsyncSequenceSnippet(items);
    }

    [Fact]
    public void Completion_AfterAsyncKeywordInParameterType_StillOffersBothAsyncSnippets()
    {
        // User has typed `async ` in a type-clause slot. The parser produces an incomplete
        // async-prefixed type clause; the caret sits inside it. Both snippets should still
        // appear so the user can pick `async func(...)` or `async sequence[T]`.
        const string source = "func foo(p async ) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p async "));

        AssertHasAsyncFuncSnippet(items);
        AssertHasAsyncSequenceSnippet(items);

        // The snippets must sort ahead of the keyword/global soup so they are surfaced first
        // when the user filters by "async".
        var asyncFuncItem = items.Single(i => i.Label == TypeClauseCompletions.AsyncFuncLabel);
        Assert.False(string.IsNullOrEmpty(asyncFuncItem.SortText));
        Assert.StartsWith("0", asyncFuncItem.SortText, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Completion_InsideExpressionPosition_DoesNotOfferAsyncSnippets()
    {
        // Caret sits inside an expression body (the `return` statement), which is NOT a
        // type-clause position. Snippets must NOT appear or they would pollute every
        // completion list in the file.
        const string source = "func foo() int32 { return  }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "return "));

        Assert.DoesNotContain(items, i => i.Label == TypeClauseCompletions.AsyncFuncLabel);
        Assert.DoesNotContain(items, i => i.Label == TypeClauseCompletions.AsyncSequenceLabel);
    }

    [Fact]
    public void Completion_InsideVariableInitializerExpression_DoesNotOfferAsyncSnippets()
    {
        // A variable initializer expression is also NOT a type-clause position.
        const string source = "let x int32 = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "let x int32 = "));

        Assert.DoesNotContain(items, i => i.Label == TypeClauseCompletions.AsyncFuncLabel);
        Assert.DoesNotContain(items, i => i.Label == TypeClauseCompletions.AsyncSequenceLabel);
    }

    [Fact]
    public void Completion_InsideFunctionReturnTypeSlot_OffersBothAsyncSnippets()
    {
        // `func foo() |{ ... }` — the optional return-type slot is a type-clause position.
        const string source = "func foo() { return }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo() "));

        AssertHasAsyncFuncSnippet(items);
        AssertHasAsyncSequenceSnippet(items);
    }

    [Fact]
    public void Completion_InsideLocalVariableTypeSlot_OffersBothAsyncSnippets()
    {
        // `let x | = ...` — the optional type-clause slot of a variable declaration.
        const string source = "func main() { let x  = 0 }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "let x "));

        AssertHasAsyncFuncSnippet(items);
        AssertHasAsyncSequenceSnippet(items);
    }

    // ---------- Snippet text: each inserted body parses cleanly as a type clause ----------

    [Theory]
    [InlineData(TypeClauseSnippetForm.AsyncFunc)]
    [InlineData(TypeClauseSnippetForm.AsyncSequence)]
    public void Snippet_PlaceholderExpansion_ParsesAsValidTypeClause(TypeClauseSnippetForm form)
    {
        var raw = form == TypeClauseSnippetForm.AsyncFunc
            ? TypeClauseCompletions.BuildAsyncFuncSnippet()
            : TypeClauseCompletions.BuildAsyncSequenceSnippet();

        // The snippet body is in LSP placeholder format `${1:T}`; expand placeholders to their
        // default values so the resulting text is G# syntax — the same text the editor would
        // commit if the user accepted the snippet without retyping.
        var expanded = ExpandPlaceholders(raw);
        Assert.Contains("async", expanded, System.StringComparison.Ordinal);

        // Embed the expanded type into a minimal program at a type-clause position, then parse
        // and assert no parser diagnostics. `let _x EXPANDED = nil` is the most compact site;
        // ADR-0042 / ADR-0043 both allow these spellings in a local's type slot.
        var program = $"func host() {{ let _x {expanded} = nil }}\n";
        var tree = SyntaxTree.Parse(program);
        Assert.Empty(tree.Diagnostics);
    }

    // ---------- Hover: ADR-rooted documentation on async type clauses ----------

    [Fact]
    public void Hover_OnAsyncKeywordOfAsyncFuncTypeClause_RendersAdr0043Documentation()
    {
        const string source = "func foo(cb async func(int32) int32) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "async"));

        Assert.NotNull(hover);
        var text = hover.Contents.ToString();
        Assert.Contains("ADR-0043", text, System.StringComparison.Ordinal);
        Assert.Contains("async func", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_OnFuncKeywordOfAsyncFuncTypeClause_RendersAdr0043Documentation()
    {
        const string source = "func foo(cb async func(int32) int32) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "func(int32)"));

        Assert.NotNull(hover);
        Assert.Contains("ADR-0043", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_OnAsyncKeywordOfAsyncSequenceTypeClause_RendersAdr0042Documentation()
    {
        const string source = "func foo(s async sequence[int32]) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "async"));

        Assert.NotNull(hover);
        var text = hover.Contents.ToString();
        Assert.Contains("ADR-0042", text, System.StringComparison.Ordinal);
        Assert.Contains("async sequence", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_OnSequenceKeywordOfAsyncSequenceTypeClause_RendersAdr0042Documentation()
    {
        const string source = "func foo(s async sequence[int32]) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "sequence"));

        Assert.NotNull(hover);
        Assert.Contains("ADR-0042", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_OnPlainSequenceKeyword_DoesNotRenderAsyncHover()
    {
        // A non-async `sequence[T]` type clause should NOT pick up the ADR-0042 hover; the
        // hover is reserved for the async-prefixed form. (The regular hover path may return
        // null here — what matters is that the ADR-0042 prose does not leak out.)
        const string source = "func foo(s sequence[int32]) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "sequence"));

        if (hover != null)
        {
            Assert.DoesNotContain("ADR-0042", hover.Contents.ToString(), System.StringComparison.Ordinal);
            Assert.DoesNotContain("ADR-0043", hover.Contents.ToString(), System.StringComparison.Ordinal);
        }
    }

    // ---------- Completion-item shape: snippet, markdown docs, both wired ----------

    [Fact]
    public void Completion_AsyncFuncSnippetItem_IsMarkedAsSnippetWithMarkdownDocs()
    {
        const string source = "func foo(p ) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "));
        var item = items.Single(i => i.Label == TypeClauseCompletions.AsyncFuncLabel);

        Assert.Equal(CompletionItemKind.Snippet, item.Kind);
        Assert.Equal(InsertTextFormat.Snippet, item.InsertTextFormat);
        Assert.Equal(TypeClauseCompletions.BuildAsyncFuncSnippet(), item.InsertText);
        Assert.NotNull(item.Documentation);
        Assert.Equal(MarkupKind.Markdown, item.Documentation.Kind);
        Assert.Contains("ADR-0043", item.Documentation.Value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Completion_AsyncSequenceSnippetItem_IsMarkedAsSnippetWithMarkdownDocs()
    {
        const string source = "func foo(p ) { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "));
        var item = items.Single(i => i.Label == TypeClauseCompletions.AsyncSequenceLabel);

        Assert.Equal(CompletionItemKind.Snippet, item.Kind);
        Assert.Equal(InsertTextFormat.Snippet, item.InsertTextFormat);
        Assert.Equal(TypeClauseCompletions.BuildAsyncSequenceSnippet(), item.InsertText);
        Assert.NotNull(item.Documentation);
        Assert.Equal(MarkupKind.Markdown, item.Documentation.Kind);
        Assert.Contains("ADR-0042", item.Documentation.Value, System.StringComparison.Ordinal);
    }

    private static void AssertHasAsyncFuncSnippet(System.Collections.Generic.IReadOnlyList<CompletionItem> items)
    {
        Assert.Contains(
            items,
            i => i.Label == TypeClauseCompletions.AsyncFuncLabel
                && i.Kind == CompletionItemKind.Snippet
                && i.InsertTextFormat == InsertTextFormat.Snippet);
    }

    private static void AssertHasAsyncSequenceSnippet(System.Collections.Generic.IReadOnlyList<CompletionItem> items)
    {
        Assert.Contains(
            items,
            i => i.Label == TypeClauseCompletions.AsyncSequenceLabel
                && i.Kind == CompletionItemKind.Snippet
                && i.InsertTextFormat == InsertTextFormat.Snippet);
    }

    private static Position AfterMarker(string source, string marker)
    {
        var start = LanguageServerTestHelpers.PositionOf(source, marker);
        return new Position(start.Line, start.Character + marker.Length);
    }

    /// <summary>
    /// Replaces every LSP placeholder of shape <c>${N:default}</c> with its default text.
    /// Used to verify the committed-snippet text is a valid G# type clause.
    /// </summary>
    /// <param name="raw">The raw snippet body.</param>
    /// <returns>The expanded text the editor would commit if the user pressed Enter without retyping.</returns>
    private static string ExpandPlaceholders(string raw)
    {
        return System.Text.RegularExpressions.Regex.Replace(raw, @"\$\{\d+:([^}]*)\}", "$1");
    }

    public enum TypeClauseSnippetForm
    {
        AsyncFunc,
        AsyncSequence,
    }
}
