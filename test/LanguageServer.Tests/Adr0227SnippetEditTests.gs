// <copyright file="Adr0227SnippetEditTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Linq
import System.Text.Json
import System.Threading
import Xunit

/// ADR-0227 D5 (issue #6129): a fix with placeholders becomes an LSP 3.18 snippet edit when the client
/// declares `workspace.workspaceEdit.snippetEditSupport` and applies `documentChanges`; otherwise the
/// server sends the plain text.
open class Adr0227SnippetEditTests {
    const Source string = "package P\n\nfunc F() string? {\n    return null\n}\n"

    // The text of the fix: `value /* $} \ */`, with `value` and `$}` as placeholders.
    const FixText string = "value /* $$} \\ */"

    @Fact
    func SnippetClient_GetsTabStops_WithTheFixedTextEscaped() {
        let documentEdit = Assert.Single(
            Fix(CodeActionClientOptions{SupportsDocumentChanges: true, SupportsSnippetEdits: true}).DocumentChanges!!
        )
        let edit = Assert.IsType[SnippetTextEdit](Assert.Single(documentEdit.Edits))
        Assert.Equal("snippet", edit.Snippet.Kind)
        Assert.Equal("$${1:value} /* $${2:\\$$\\}} \\\\ */", edit.Snippet.Value)
        Assert.Equal("value /* $$} \\ */", edit.NewText)
        let json = JsonSerializer.Serialize(documentEdit, LspJson.Options)
        Assert.Contains("\"snippet\":{\"kind\":\"snippet\",\"value\":", json)
        Assert.DoesNotContain("\"newText\"", json)
        // The client reads the edit back as a snippet edit.
        let read = JsonSerializer.Deserialize[TextDocumentEdit](json, LspJson.Options)
        let readEdit = Assert.IsType[SnippetTextEdit](Assert.Single(read.Edits))
        Assert.Equal(edit.Snippet.Value, readEdit.Snippet.Value)
        Assert.Equal(edit.Range.Start.Character, readEdit.Range.Start.Character)
    }

    @Fact
    func ClientWithoutSnippetSupport_GetsThePlainText() {
        let documentEdit = Assert.Single(Fix(CodeActionClientOptions{SupportsDocumentChanges: true}).DocumentChanges!!)
        let edit = Assert.Single(documentEdit.Edits)
        Assert.IsNotType[SnippetTextEdit](edit)
        Assert.Equal("value /* $$} \\ */", edit.NewText)
        let json = JsonSerializer.Serialize(documentEdit, LspJson.Options)
        Assert.Contains("\"newText\":", json)
        Assert.DoesNotContain("\"snippet\"", json)
    }

    @Fact
    func SnippetClient_WithoutDocumentChanges_GetsThePlainText() {
        // A snippet edit is only legal in `documentChanges`.
        let edit = Fix(CodeActionClientOptions{SupportsSnippetEdits: true})
        Assert.Null(edit.DocumentChanges)
        let change = Assert.Single(edit.Changes!!.Values.Single())
        Assert.IsNotType[SnippetTextEdit](change)
        Assert.Equal("value /* $$} \\ */", change.NewText)
    }

    @Fact
    func FixWithoutPlaceholders_StaysPlain_ForASnippetClient() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let action = CodeActionComputer
            .ComputeCodeActions(
            uri,
            content,
            Range(at, at),
            nil,
            CodeActionClientOptions{SupportsDocumentChanges: true, SupportsSnippetEdits: true}
        )
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.IsNotType[SnippetTextEdit](Assert.Single(Assert.Single(action.Edit!!.DocumentChanges!!).Edits))
    }

    @Fact
    func Escape_PrefixesDollarBraceAndBackslash() {
        Assert.Equal("a\\$$b\\}c\\\\d{", CodeActionComputer.EscapeSnippet("a$$b}c\\d{"))
        Assert.Equal(string.Empty, CodeActionComputer.EscapeSnippet(string.Empty))
    }

    private func Fix(client CodeActionClientOptions) WorkspaceEdit {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let registry = CodeFixRegistry()
        registry.Add(PlaceholderProvider())
        let action = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client, registry, default(CancellationToken))
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Write a value")
            .CodeAction
        return action.Edit!!
    }

    // Replaces `null` with text that has two placeholders and every character a snippet escapes.
    private class PlaceholderProvider : GSharpCodeFixProvider {
        override prop FixableDiagnosticIds System
            .Collections
            .Immutable
            .ImmutableArray[string] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create("GS0273")

        override func RegisterCodeFixes(context CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "Write a value",
                "test.placeholder",
                Applicability.HasPlaceholders,
                (editor SyntaxEditor) -> {
                    editor.ReplaceToken(token, Adr0227SnippetEditTests.FixText)
                    editor.MarkPlaceholder(0, 5)
                    editor.MarkPlaceholder(9, 2)
                }
            )
        }
    }
}
