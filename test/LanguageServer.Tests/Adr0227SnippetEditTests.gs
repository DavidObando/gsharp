// <copyright file="Adr0227SnippetEditTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text.Json
import System.Threading
import System.Threading.Tasks
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

    @Theory
    @InlineData("{\"workspace\":{\"workspaceEdit\":{\"documentChanges\":true,\"snippetEditSupport\":true}}}", true)
    @InlineData("{\"workspace\":{\"workspaceEdit\":{\"documentChanges\":true,\"snippetEditSupport\":false}}}", false)
    @InlineData("{\"workspace\":{\"workspaceEdit\":{\"documentChanges\":true}}}", false)
    async func Initialize_ReadsSnippetEditSupport(capabilities string, expected bool) {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        using let document = JsonDocument.Parse(capabilities)
        await server.InitializeAsync(InitializeParams{Capabilities: document.RootElement.Clone()})
        Assert.Equal(expected, server.CodeActionOptions.SupportsSnippetEdits)
        Assert.True(server.CodeActionOptions.SupportsDocumentChanges)
    }

    @Fact
    func LazyClient_ResolvesTheSnippetEdit() {
        let client = CodeActionClientOptions{
            SupportsDocumentChanges: true,
            SupportsSnippetEdits: true,
            SupportsResolveEdit: true
        }
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let registry = CodeFixRegistry()
        registry.Add(PlaceholderProvider())
        let listed = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client, registry, default(CancellationToken))
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Write a value")
            .CodeAction
        Assert.Null(listed.Edit)
        let resolved = CodeActionComputer.ResolveCodeAction(listed, content, client)
        let edit = Assert.IsType[SnippetTextEdit](Assert.Single(Assert.Single(resolved.Edit!!.DocumentChanges!!).Edits))
        Assert.Equal("$${1:value} /* $${2:\\$$\\}} \\\\ */", edit.Snippet.Value)
    }

    @Fact
    func SnippetEdits_NumberTabStopsAcrossChanges_AtTheirOffsetsInTheChangedText() {
        // The first change is shorter than the text it replaces, so the placeholder of the second change
        // sits two characters before its original position in the changed text.
        let tree = SyntaxTree.Parse(SourceText.From(Source, "a.gs"))
        let first = Source.IndexOf("string?", StringComparison.Ordinal)
        let second = Source.IndexOf("null", StringComparison.Ordinal)
        let changes = ImmutableArray.Create(
            TextChange(TextSpan(first, 7), "int32"),
            TextChange(TextSpan(second, 4), "0 + n")
        )
        let placeholders = ImmutableArray.Create(TextSpan(first, 5), TextSpan(second - 2 + 4, 1))
        let edits = CodeActionComputer.SnippetEdits(DocumentChanges(tree, changes, placeholders))
        Assert.Equal(2, edits.Count)
        Assert.Equal("$${1:int32}", Assert.IsType[SnippetTextEdit](edits[0]).Snippet.Value)
        Assert.Equal("0 + $${2:n}", Assert.IsType[SnippetTextEdit](edits[1]).Snippet.Value)
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        Assert.Equal(at.Line, edits[1].Range.Start.Line)
        Assert.Equal(at.Character, edits[1].Range.Start.Character)
    }

    @Fact
    func SnippetEdits_KeepAChangeWithoutAPlaceholderPlain() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "a.gs"))
        let first = Source.IndexOf("string?", StringComparison.Ordinal)
        let second = Source.IndexOf("null", StringComparison.Ordinal)
        let changes = ImmutableArray.Create(
            TextChange(TextSpan(first, 7), "int32"),
            TextChange(TextSpan(second, 4), "0")
        )
        let placeholders = ImmutableArray.Create(TextSpan(second - 2, 1))
        let edits = CodeActionComputer.SnippetEdits(DocumentChanges(tree, changes, placeholders))
        Assert.IsNotType[SnippetTextEdit](edits[0])
        Assert.Equal("int32", edits[0].NewText)
        Assert.Equal("$${1:0}", Assert.IsType[SnippetTextEdit](edits[1]).Snippet.Value)
    }

    @Fact
    func SnippetEdits_PlaceholderOutsideTheNewTextOfOneChange_GivesPlainEdits() {
        // The first placeholder runs from the new text of the first change into unchanged text.
        let tree = SyntaxTree.Parse(SourceText.From(Source, "a.gs"))
        let first = Source.IndexOf("string?", StringComparison.Ordinal)
        let second = Source.IndexOf("null", StringComparison.Ordinal)
        let changes = ImmutableArray.Create(
            TextChange(TextSpan(first, 7), "int32"),
            TextChange(TextSpan(second, 4), "0")
        )
        let placeholders = ImmutableArray.Create(TextSpan(first + 3, 4), TextSpan(second - 2, 1))
        let edits = CodeActionComputer.SnippetEdits(DocumentChanges(tree, changes, placeholders))
        Assert.Equal(2, edits.Count)
        Assert.IsNotType[SnippetTextEdit](edits[0])
        Assert.IsNotType[SnippetTextEdit](edits[1])
        Assert.Equal("int32", edits[0].NewText)
        Assert.Equal("0", edits[1].NewText)
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
