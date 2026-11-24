// <copyright file="Adr0227SnippetEditTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import Nerdbank.Streams
import Range = GSharp.LanguageServer.Protocol.Range
import StreamJsonRpc
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

    // ADR-0227 D5 (issue #6164): a client without tab stops gets placeholder text that binds.
    @Theory
    @InlineData(true)
    @InlineData(false)
    func PlainClient_GetsATargetTypedDefault_ThatBinds(documentChanges bool) {
        let edit = Fix(CodeActionClientOptions{SupportsDocumentChanges: documentChanges}, "value", 0, 5)
        let change = SingleEdit(edit)
        Assert.IsNotType[SnippetTextEdit](change)
        Assert.Equal("default /* TODO: value */", change.NewText)
        AssertBindsWithoutErrors(change)
    }

    @Fact
    func SnippetClient_GetsTheTabStop_ForTheSameFix() {
        let edit = Fix(
            CodeActionClientOptions{SupportsDocumentChanges: true, SupportsSnippetEdits: true},
            "value",
            0,
            5
        )
        let change = Assert.IsType[SnippetTextEdit](SingleEdit(edit))
        Assert.Equal("$${1:value}", change.Snippet.Value)
        Assert.Equal("value", change.NewText)
    }

    @Fact
    func PlainClient_KeepsAPlaceholderThatBinds() {
        let edit = Fix(CodeActionClientOptions{SupportsDocumentChanges: true}, "nil", 0, 3)
        let change = SingleEdit(edit)
        Assert.Equal("nil", change.NewText)
        AssertBindsWithoutErrors(change)
    }

    @Fact
    func PlainClient_KeepsTheText_WhenNoDefaultBinds() {
        // A placeholder in a type position: `default` does not parse there.
        let edit = Fix(CodeActionClientOptions{SupportsDocumentChanges: true}, "cast[T](nil)", 5, 1)
        Assert.Equal("cast[T](nil)", SingleEdit(edit).NewText)
    }

    @Fact
    func PlaceholderDefault_LeavesOutTextThatWouldEndTheComment() {
        Assert.Equal("default /* TODO: value */", CodeActionComputer.PlaceholderDefault("value"))
        Assert.Equal("default /* TODO */", CodeActionComputer.PlaceholderDefault("a */ b"))
        Assert.Equal("default /* TODO */", CodeActionComputer.PlaceholderDefault("a\nb"))
        Assert.Equal("default /* TODO */", CodeActionComputer.PlaceholderDefault(string.Empty))
    }

    @Fact
    func ReplacePlaceholders_MovesTheLaterPlaceholders() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "a.gs"))
        let first = Source.IndexOf("string?", StringComparison.Ordinal)
        let second = Source.IndexOf("null", StringComparison.Ordinal)
        let changes = FixChanges(
            ImmutableArray.Create(
                DocumentChanges(
                    tree,
                    ImmutableArray.Create(
                        TextChange(TextSpan(first, 7), "int32"),
                        TextChange(TextSpan(second, 4), "0 + n")
                    ),
                    ImmutableArray.Create(TextSpan(first, 5), TextSpan(second - 2 + 4, 1))
                )
            )
        )
        let replaced = CodeActionComputer.ReplacePlaceholders(changes, (t string) -> "<${t}>")!!
        let document = Assert.Single(replaced.Documents)
        Assert.Equal("<int32>", document.Changes[0].NewText)
        Assert.Equal("0 + <n>", document.Changes[1].NewText)
        let text = document.GetChangedText().ToString()
        Assert.Equal("<int32>", text.Substring(document.Placeholders[0].Start, document.Placeholders[0].Length))
        Assert.Equal("<n>", text.Substring(document.Placeholders[1].Start, document.Placeholders[1].Length))
    }

    // ADR-0227 D5 (issue #6185): a client without snippet edits that supports `window/showDocument`
    // gets a command that selects the placeholder after the edit.
    @Theory
    @InlineData(true, false)
    @InlineData(false, false)
    @InlineData(false, true)
    func PlainClientWithShowDocument_GetsACommand_ThatSelectsThePlaceholderInTheChangedText(
        documentChanges bool,
        resolve bool
    ) {
        let client = CodeActionClientOptions{
            SupportsDocumentChanges: documentChanges,
            SupportsShowDocument: true,
            SupportsResolveEdit: resolve
        }
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        var action = FixAction(client, content, "value", 0, 5)
        if resolve {
            Assert.Null(action.Edit)
            // The command survives the round trip of a lazy client.
            let json = JsonSerializer.Serialize(action, LspJson.Options)
            action = CodeActionComputer.ResolveCodeAction(
                JsonSerializer.Deserialize[CodeAction](json, LspJson.Options),
                content,
                client
            )
        }
        let change = SingleEdit(action.Edit!!)
        Assert.Equal("default /* TODO: value */", change.NewText)
        let command = action.Command!!
        Assert.Equal(CodeActionComputer.SelectPlaceholderCommand, command.Name)
        let arguments = Arguments(Assert.Single(command.Arguments))
        Assert.Equal("file:///a.gs", arguments.Uri)
        Assert.Equal("default /* TODO: value */", arguments.Text)
        // The range is in the text after the edit: `    return default /* TODO: value */` on line 3.
        Assert.Equal(3, arguments.Range.Start.Line)
        Assert.Equal(11, arguments.Range.Start.Character)
        Assert.Equal(3, arguments.Range.End.Line)
        Assert.Equal(36, arguments.Range.End.Character)
        let edited = Apply(change)
        Assert.Equal("default /* TODO: value */", Slice(edited, arguments.Range))
        // The range in the text before the edit would end on another line.
        Assert.NotEqual(
            arguments.Range.End.Line,
            SemanticLookup.ToRange(SourceText.From(Source), TextSpan(Source.IndexOf("null"), 25)).End.Line
        )
        Assert.True(CodeActionComputer.HoldsPlaceholder(LanguageServerTestHelpers.Content(edited), arguments))
        Assert.False(CodeActionComputer.HoldsPlaceholder(content, arguments))
    }

    @Fact
    func ClientsWithoutShowDocument_OrWithSnippetEdits_GetNoCommand() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        // A client with neither capability keeps the plain edit alone.
        let plain = FixAction(CodeActionClientOptions{SupportsDocumentChanges: true}, content, "value", 0, 5)
        Assert.Equal("default /* TODO: value */", SingleEdit(plain.Edit!!).NewText)
        Assert.Null(plain.Command)
        Assert.DoesNotContain("\"command\"", JsonSerializer.Serialize(plain, LspJson.Options))
        // A snippet client gets the tab stop.
        let snippet = FixAction(
            CodeActionClientOptions{
                SupportsDocumentChanges: true,
                SupportsSnippetEdits: true,
                SupportsShowDocument: true
            },
            content,
            "value",
            0,
            5
        )
        Assert.IsType[SnippetTextEdit](SingleEdit(snippet.Edit!!))
        Assert.Null(snippet.Command)
        // A fix without placeholders gets no command.
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let builtIn = CodeActionComputer
            .ComputeCodeActions(
            DocumentUri.From("file:///a.gs")!!,
            content,
            Range(at, at),
            nil,
            CodeActionClientOptions{SupportsShowDocument: true}
        )
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.Null(builtIn.Command)
    }

    @Theory
    @InlineData("{\"window\":{\"showDocument\":{\"support\":true}}}", true, true)
    @InlineData(
        "{\"window\":{\"showDocument\":{\"support\":true}},\"workspace\":{\"workspaceEdit\":{\"documentChanges\":true,\"snippetEditSupport\":true}}}",
        true,
        false
    )
    @InlineData("{\"window\":{\"showDocument\":{\"support\":false}}}", false, false)
    @InlineData("{}", false, false)
    async func Initialize_ReadsShowDocumentSupport_AndAdvertisesTheCommandForAPlainClient(
        capabilities string,
        showDocument bool,
        command bool
    ) {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        using let document = JsonDocument.Parse(capabilities)
        let result = await server.InitializeAsync(InitializeParams{Capabilities: document.RootElement.Clone()})
        Assert.Equal(showDocument, server.CodeActionOptions.SupportsShowDocument)
        if command {
            Assert.Equal(
                CodeActionComputer.SelectPlaceholderCommand,
                Assert.Single(result.Capabilities.ExecuteCommandProvider!!.Commands)
            )
        } else {
            Assert.Null(result.Capabilities.ExecuteCommandProvider)
            Assert.DoesNotContain(
                "executeCommandProvider",
                JsonSerializer.Serialize(result.Capabilities, LspJson.Options)
            )
        }
    }

    // Over JSON-RPC: the client runs the command after it applies the edit, and the server asks it to
    // show the document with the placeholder selected.
    // The client can open the document under another encoding of its path than the edit names.
    @Theory
    @InlineData("file:///a.gs")
    @InlineData("file:///%61.gs")
    async func ExecuteCommand_OverRpc_SendsShowDocumentWithThePlaceholderSelected(opened string) {
        let uri = DocumentUri.From("file:///a.gs")!!
        let client = CodeActionClientOptions{SupportsDocumentChanges: true, SupportsShowDocument: true}
        let action = FixAction(client, LanguageServerTestHelpers.Content(Source).WithVersion(1), "value", 0, 5)
        let edited = Apply(SingleEdit(action.Edit!!))
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let (clientStream, serverStream) = FullDuplexStream.CreatePair()
        using let serverRpc = JsonRpc(
            HeaderDelimitedMessageHandler(serverStream, serverStream, LspJson.CreateFormatter())
        )
        serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
        server.Attach(serverRpc)
        serverRpc.StartListening()
        using let clientRpc = JsonRpc(
            HeaderDelimitedMessageHandler(clientStream, clientStream, LspJson.CreateFormatter())
        )
        let window = ShowDocumentClient()
        clientRpc.AddLocalRpcTarget(window)
        clientRpc.StartListening()
        using let capabilities = JsonDocument.Parse(
            "{\"capabilities\":{\"window\":{\"showDocument\":{\"support\":true}},\"workspace\":{\"workspaceEdit\":{\"documentChanges\":true}}}}"
        )
        let initialized = await clientRpc.InvokeWithParameterObjectAsync[InitializeResult](
            "initialize",
            capabilities.RootElement.Clone()
        )
        Assert.Equal(
            CodeActionComputer.SelectPlaceholderCommand,
            Assert.Single(initialized.Capabilities.ExecuteCommandProvider!!.Commands)
        )
        await clientRpc.NotifyWithParameterObjectAsync(
            "textDocument/didOpen",
            DidOpenTextDocumentParams{
                TextDocument: TextDocumentItem{
                    Uri: DocumentUri.From(opened)!!,
                    LanguageId: "gsharp",
                    Version: 2,
                    Text: edited
                }
            }
        )
        // The command as the client got it, over JSON.
        let wire = JsonSerializer.Deserialize[CodeAction](
            JsonSerializer.Serialize(action, LspJson.Options),
            LspJson.Options
        )
        let command = wire.Command!!
        await clientRpc.InvokeWithParameterObjectAsync[JsonElement](
            "workspace/executeCommand",
            ExecuteCommandParams{
                Command: command.Name,
                Arguments: command.Arguments.Select((a object?) -> cast[JsonElement](a!!)).ToArray()
            }
        )
        let shown = await window.Shown.Task.WaitAsync(TimeSpan.FromSeconds(30))
        Assert.Equal(uri.ToString(), shown.Uri.ToString())
        Assert.True(shown.TakeFocus)
        Assert.Equal("default /* TODO: value */", Slice(edited, shown.Selection!!))
        Assert.Equal(3, shown.Selection!!.Start.Line)
        Assert.Equal(11, shown.Selection!!.Start.Character)
        Assert.Equal(36, shown.Selection!!.End.Character)
    }

    @Fact
    func LazyClient_ThatResolvesAStaleAction_GetsNoCommand() {
        // The command selects the placeholder of the edit, so an action without its edit has no command.
        let client = CodeActionClientOptions{SupportsShowDocument: true, SupportsResolveEdit: true}
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let listed = FixAction(client, content, "value", 0, 5)
        Assert.NotNull(listed.Command)
        let json = JsonSerializer.Serialize(listed, LspJson.Options)
        let stale = CodeActionComputer.ResolveCodeAction(
            JsonSerializer.Deserialize[CodeAction](json, LspJson.Options),
            content.WithVersion(2),
            client
        )
        Assert.Null(stale.Edit)
        Assert.Null(stale.Command)
    }

    @Fact
    async func Resolve_OfAnActionWhoseDocumentIsNotOpen_GivesNoCommand() {
        // The server has no document for the action (it was closed), so the action gets no edit and no
        // command, and the action that the client sent is not changed.
        let client = CodeActionClientOptions{SupportsShowDocument: true, SupportsResolveEdit: true}
        let listed = FixAction(client, LanguageServerTestHelpers.Content(Source).WithVersion(1), "value", 0, 5)
        Assert.NotNull(listed.Command)
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let resolved = await server.CodeActionResolveAsync(listed)
        Assert.Null(resolved.Edit)
        Assert.Null(resolved.Command)
        Assert.NotNull(listed.Command)
    }

    @Fact
    func HoldsPlaceholder_AcceptsTheRangeOfAPlaceholderThatEndsWithACarriageReturn() {
        // At the end of the text, the range of `nil\r` ends after the CR on the same line.
        let text = "nil\r"
        let $range = SemanticLookup.ToRange(SourceText.From(text), TextSpan(0, 4))
        let arguments = SelectPlaceholderArguments{Uri: "file:///a.gs", Range: $range, Text: text}
        Assert.True(CodeActionComputer.HoldsPlaceholder(LanguageServerTestHelpers.Content(text), arguments))
        Assert.False(CodeActionComputer.HoldsPlaceholder(LanguageServerTestHelpers.Content("nul\r"), arguments))
    }

    @Fact
    func SelectPlaceholder_GivesNoCommand_ForAnEmptyOrOutOfRangeSpan() {
        let content = LanguageServerTestHelpers.Content(Source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = Source.IndexOf("null", StringComparison.Ordinal)
        for span in[]TextSpan{
            TextSpan(-1, 1),
            TextSpan(at, 0),
            TextSpan(Source.Length, 3),
            TextSpan(1, int32.MaxValue)
        } {
            let changes = FixChanges(
                ImmutableArray.Create(
                    DocumentChanges(
                        content.SyntaxTree,
                        ImmutableArray.Create(TextChange(TextSpan(at, 4), "nil")),
                        ImmutableArray.Create(span)
                    )
                )
            )
            Assert.Null(CodeActionComputer.SelectPlaceholder(uri, content, changes))
        }
        let valid = FixChanges(
            ImmutableArray.Create(
                DocumentChanges(
                    content.SyntaxTree,
                    ImmutableArray.Create(TextChange(TextSpan(at, 4), "nil")),
                    ImmutableArray.Create(TextSpan(at, 3))
                )
            )
        )
        Assert.NotNull(CodeActionComputer.SelectPlaceholder(uri, content, valid))
    }

    // The client side of `window/showDocument`.
    class ShowDocumentClient {
        let Shown TaskCompletionSource[ShowDocumentParams] = TaskCompletionSource[ShowDocumentParams](
            TaskCreationOptions.RunContinuationsAsynchronously
        )

        @JsonRpcMethod("window/showDocument", UseSingleObjectParameterDeserialization = true)
        func ShowDocument(request ShowDocumentParams) JsonElement {
            Shown.TrySetResult(request)
            using let reply = JsonDocument.Parse("{\"success\":true}")
            return reply.RootElement.Clone()
        }
    }

    private func FixAction(
        client CodeActionClientOptions,
        content DocumentContent,
        text string,
        start int32,
        length int32
    ) CodeAction {
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let registry = CodeFixRegistry()
        registry.Add(PlaceholderProvider(text, start, length))
        return CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client, registry, default(CancellationToken))
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Write a value")
            .CodeAction
    }

    // The argument of the command, in memory or as the client read it back from JSON.
    private func Arguments(argument object?) SelectPlaceholderArguments {
        if argument is JsonElement element {
            return element.Deserialize[SelectPlaceholderArguments](LspJson.Options)
        }
        return Assert.IsType[SelectPlaceholderArguments](argument)
    }

    // The source after the edit.
    private func Apply(change GSharp.LanguageServer.Protocol.TextEdit) string {
        let text = SourceText.From(Source, "a.gs")
        let start = text.Lines[cast[int32](change.Range.Start.Line)].Start + cast[int32](change.Range.Start.Character)
        let end = text.Lines[cast[int32](change.Range.End.Line)].Start + cast[int32](change.Range.End.Character)
        return Source.Substring(0, start) + change.NewText + Source.Substring(end)
    }

    private func Slice(source string, $range Range) string {
        let text = SourceText.From(source)
        let start = text.Lines[$range.Start.Line].Start + $range.Start.Character
        let end = text.Lines[$range.End.Line].Start + $range.End.Character
        return source.Substring(start, end - start)
    }

    private func SingleEdit(edit WorkspaceEdit) GSharp.LanguageServer.Protocol.TextEdit {
        if edit.DocumentChanges != nil {
            return Assert.Single(Assert.Single(edit.DocumentChanges).Edits)
        }
        return Assert.Single(edit.Changes!!.Values.Single())
    }

    // Applies the edit to the source and binds the result.
    private func AssertBindsWithoutErrors(change GSharp.LanguageServer.Protocol.TextEdit) {
        let text = SourceText.From(Source, "a.gs")
        let start = text.Lines[cast[int32](change.Range.Start.Line)].Start + cast[int32](change.Range.Start.Character)
        let end = text.Lines[cast[int32](change.Range.End.Line)].Start + cast[int32](change.Range.End.Character)
        let edited = Source.Substring(0, start) + change.NewText + Source.Substring(end)
        let errors = Compilation(SyntaxTree.Parse(SourceText.From(edited, "a.gs")))
            .GetDiagnostics()
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToList()
        Assert.True(
            errors.Count == 0,
            "${edited}: ${string.Join("; ", errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))}"
        )
    }

    private func Fix(client CodeActionClientOptions, text string, start int32, length int32) WorkspaceEdit {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let registry = CodeFixRegistry()
        registry.Add(PlaceholderProvider(text, start, length))
        let action = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client, registry, default(CancellationToken))
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Write a value")
            .CodeAction
        return action.Edit!!
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

    // Replaces `null` with text that has two placeholders and every character a snippet escapes, or with
    // the given text and one placeholder.
    private class PlaceholderProvider : GSharpCodeFixProvider {
        private var text string? = nil
        private var start int32 = 0
        private var length int32 = 0

        init() { }

        init(text string, start int32, length int32) {
            this.text = text
            this.start = start
            this.length = length
        }

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
                    if text is {} given {
                        editor.ReplaceToken(token, given)
                        editor.MarkPlaceholder(start, length)
                        return
                    }
                    editor.ReplaceToken(token, Adr0227SnippetEditTests.FixText)
                    editor.MarkPlaceholder(0, 5)
                    editor.MarkPlaceholder(9, 2)
                }
            )
        }
    }
}
