// <copyright file="AsyncTypeClauseCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #713 — exercises the LSP completion and hover polish for the two
/// async type-clause spellings:
/// - `async (...) -> R` (ADR-0043 / ADR-0075) — alias for `(...) -> Task[R]`.
/// - `async sequence[T]` (ADR-0042) — alias for `IAsyncEnumerable[T]`.
open class AsyncTypeClauseCompletionTests {
    // ---------- Completion: snippets surface in type-clause positions ----------
    @Fact
    func Completion_AtStartOfEmptyParameterTypeSlot_OffersBothAsyncSnippets() {
        // Cursor right after the parameter identifier, before any type characters have been
        // typed: `func foo(p |)`. This is the canonical "empty type-clause position".
        const source = "func foo(p ) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "))
        AssertHasAsyncFuncSnippet(items)
        AssertHasAsyncSequenceSnippet(items)
    }

    @Fact
    func Completion_AfterAsyncKeywordInParameterType_StillOffersBothAsyncSnippets() {
        // User has typed `async ` in a type-clause slot. The parser produces an incomplete
        // async-prefixed type clause; the caret sits inside it. Both snippets should still
        // appear so the user can pick `async (...) -> R` or `async sequence[T]`.
        const source = "func foo(p async ) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p async "))
        AssertHasAsyncFuncSnippet(items)
        AssertHasAsyncSequenceSnippet(items)
        // The snippets must sort ahead of the keyword/global soup so they are surfaced first
        // when the user filters by "async".
        let asyncFuncItem = items.Single((i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncFuncLabel)
        Assert.False(string.IsNullOrEmpty(asyncFuncItem.SortText))
        Assert.StartsWith("0", asyncFuncItem.SortText, StringComparison.Ordinal)
    }

    @Fact
    func Completion_InsideExpressionPosition_DoesNotOfferAsyncSnippets() {
        // Caret sits inside an expression body (the `return` statement), which is NOT a
        // type-clause position. Snippets must NOT appear or they would pollute every
        // completion list in the file.
        const source = "func foo() int32 { return  }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "return "))
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncFuncLabel)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncSequenceLabel)
    }

    @Fact
    func Completion_InsideVariableInitializerExpression_DoesNotOfferAsyncSnippets() {
        // A variable initializer expression is also NOT a type-clause position.
        const source = "let x int32 = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "let x int32 = "))
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncFuncLabel)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncSequenceLabel)
    }

    @Fact
    func Completion_InsideFunctionReturnTypeSlot_OffersBothAsyncSnippets() {
        // `func foo() |{ ... }` — the optional return-type slot is a type-clause position.
        const source = "func foo() { return }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo() "))
        AssertHasAsyncFuncSnippet(items)
        AssertHasAsyncSequenceSnippet(items)
    }

    @Fact
    func Completion_InsideLocalVariableTypeSlot_OffersBothAsyncSnippets() {
        // `let x | = ...` — the optional type-clause slot of a variable declaration.
        const source = "func main() { let x  = 0 }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "let x "))
        AssertHasAsyncFuncSnippet(items)
        AssertHasAsyncSequenceSnippet(items)
    }

    // ---------- Snippet text: each inserted body parses cleanly as a type clause ----------
    @Theory
    @InlineData(TypeClauseSnippetForm(0))
    @InlineData(TypeClauseSnippetForm(1))
    func Snippet_PlaceholderExpansion_ParsesAsValidTypeClause(form TypeClauseSnippetForm) {
        let raw = if form == TypeClauseSnippetForm.AsyncFunc {
            TypeClauseCompletions.BuildAsyncFuncSnippet()
        } else {
            TypeClauseCompletions.BuildAsyncSequenceSnippet()
        }
        // The snippet body is in LSP placeholder format `${1:T}`; expand placeholders to their
        // default values so the resulting text is G# syntax — the same text the editor would
        // commit if the user accepted the snippet without retyping.
        let expanded = ExpandPlaceholders(raw)
        Assert.Contains("async", expanded, StringComparison.Ordinal)
        // Embed the expanded type into a minimal program at a type-clause position, then parse
        // and assert no parser diagnostics. `let _x EXPANDED = nil` is the most compact site;
        // ADR-0042 / ADR-0043 both allow these spellings in a local's type slot.
        let program = (`func host() { let _x ` + "$expanded" + ` = nil }
`)
        let tree = SyntaxTree.Parse(program)
        Assert.Empty(tree.Diagnostics)
    }

    // ---------- Hover: ADR-rooted documentation on async type clauses ----------
    @Fact
    func Hover_OnAsyncKeywordOfAsyncFuncTypeClause_RendersAdr0043Documentation() {
        const source = "func foo(cb async (int32) -> int32) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "async"))
        Assert.NotNull(hover)
        let text = hover!!.Contents.ToString()
        Assert.Contains("ADR-0043", text, StringComparison.Ordinal)
        Assert.Contains("async", text, StringComparison.Ordinal)
    }

    @Fact
    func Hover_OnArrowOfAsyncArrowFunctionTypeClause_RendersAdr0043Documentation() {
        const source = "func foo(cb async (int32) -> int32) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "->"))
        Assert.NotNull(hover)
        Assert.Contains("ADR-0043", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Hover_OnAsyncKeywordOfAsyncSequenceTypeClause_RendersAdr0042Documentation() {
        const source = "func foo(s async sequence[int32]) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "async"))
        Assert.NotNull(hover)
        let text = hover!!.Contents.ToString()
        Assert.Contains("ADR-0042", text, StringComparison.Ordinal)
        Assert.Contains("async sequence", text, StringComparison.Ordinal)
    }

    @Fact
    func Hover_OnSequenceKeywordOfAsyncSequenceTypeClause_RendersAdr0042Documentation() {
        const source = "func foo(s async sequence[int32]) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "sequence"))
        Assert.NotNull(hover)
        Assert.Contains("ADR-0042", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Hover_OnPlainSequenceKeyword_DoesNotRenderAsyncHover() {
        // A non-async `sequence[T]` type clause should NOT pick up the ADR-0042 hover; the
        // hover is reserved for the async-prefixed form. (The regular hover path may return
        // null here — what matters is that the ADR-0042 prose does not leak out.)
        const source = "func foo(s sequence[int32]) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "sequence"))
        if hover != nil {
            Assert.DoesNotContain("ADR-0042", hover.Contents.ToString(), StringComparison.Ordinal)
            Assert.DoesNotContain("ADR-0043", hover.Contents.ToString(), StringComparison.Ordinal)
        }
    }

    // ---------- Completion-item shape: snippet, markdown docs, both wired ----------
    @Fact
    func Completion_AsyncFuncSnippetItem_IsMarkedAsSnippetWithMarkdownDocs() {
        const source = "func foo(p ) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "))
        let item = items.Single((i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncFuncLabel)
        Assert.Equal(CompletionItemKind.Snippet, item.Kind)
        Assert.Equal(InsertTextFormat.Snippet, item.InsertTextFormat)
        Assert.Equal(TypeClauseCompletions.BuildAsyncFuncSnippet(), item.InsertText)
        Assert.NotNull(item.Documentation)
        Assert.Equal(MarkupKind.Markdown, item.Documentation.Kind)
        Assert.Contains("ADR-0043", item.Documentation.Value, StringComparison.Ordinal)
    }

    @Fact
    func Completion_AsyncSequenceSnippetItem_IsMarkedAsSnippetWithMarkdownDocs() {
        const source = "func foo(p ) { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, AfterMarker(source, "func foo(p "))
        let item = items.Single((i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncSequenceLabel)
        Assert.Equal(CompletionItemKind.Snippet, item.Kind)
        Assert.Equal(InsertTextFormat.Snippet, item.InsertTextFormat)
        Assert.Equal(TypeClauseCompletions.BuildAsyncSequenceSnippet(), item.InsertText)
        Assert.NotNull(item.Documentation)
        Assert.Equal(MarkupKind.Markdown, item.Documentation.Kind)
        Assert.Contains("ADR-0042", item.Documentation.Value, StringComparison.Ordinal)
    }

    enum TypeClauseSnippetForm {
        AsyncFunc,
        AsyncSequence
    }

    shared {
        private func AssertHasAsyncFuncSnippet(items IReadOnlyList[CompletionItem]) {
            Assert.Contains(
                items,
                (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncFuncLabel &&
                    i.Kind == CompletionItemKind.Snippet &&
                    i.InsertTextFormat == InsertTextFormat.Snippet
            )
        }

        private func AssertHasAsyncSequenceSnippet(items IReadOnlyList[CompletionItem]) {
            Assert.Contains(
                items,
                (i CompletionItem) -> i.Label == TypeClauseCompletions.AsyncSequenceLabel &&
                    i.Kind == CompletionItemKind.Snippet &&
                    i.InsertTextFormat == InsertTextFormat.Snippet
            )
        }

        private func AfterMarker(source string, marker string) Position {
            let start = LanguageServerTestHelpers.PositionOf(source, marker)
            return Position(start.Line, start.Character + marker.Length)
        }

        /// Replaces every LSP placeholder of shape `${N:default}` with its default text.
        /// Used to verify the committed-snippet text is a valid G# type clause.
        /// @param raw The raw snippet body.
        /// @returns The expanded text the editor would commit if the user pressed Enter without retyping.
        private func ExpandPlaceholders(raw string) string {
            return Regex.Replace(raw, "\\$$\\{\\d+:([^}]*)\\}", "$$1")
        }
    }
}
