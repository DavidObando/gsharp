// <copyright file="LspServerParityContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.Json.Nodes
import System.Threading
import System.Threading.Tasks
import Xunit

open class LspServerParityContractTests {
    @Fact
    async func Initialize_CapabilitiesMatchSnapshot() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let result = await server.InitializeAsync(InitializeParams())
        let actual JsonNode? = JsonNode.Parse(JsonSerializer.Serialize(result.Capabilities, LspJson.Options))
        let expected JsonNode? = JsonNode.Parse(`{
  "textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":true}},
  "hoverProvider":true,
  "definitionProvider":true,
  "typeDefinitionProvider":true,
  "implementationProvider":true,
  "referencesProvider":true,
  "documentHighlightProvider":true,
  "documentSymbolProvider":true,
  "workspaceSymbolProvider":true,
  "codeActionProvider":{"codeActionKinds":["quickfix","refactor.rewrite"]},
  "codeLensProvider":{"resolveProvider":false},
  "documentFormattingProvider":true,
  "documentRangeFormattingProvider":true,
  "documentOnTypeFormattingProvider":{"firstTriggerCharacter":"}","moreTriggerCharacter":[";","\n"]},
  "renameProvider":{"prepareProvider":true},
  "foldingRangeProvider":true,
  "selectionRangeProvider":true,
  "semanticTokensProvider":{
    "legend":{
      "tokenTypes":["namespace","type","struct","interface","enum","enumMember","typeParameter","parameter","variable","property","function","method","keyword","string","number","operator","comment","event"],
      "tokenModifiers":["declaration","definition","readonly","static","async","deprecated"]
    },
    "full":{"delta":false},
    "range":true
  },
  "completionProvider":{"triggerCharacters":["."],"resolveProvider":false},
  "signatureHelpProvider":{"triggerCharacters":["(",","] ,"retriggerCharacters":[","]},
  "inlayHintProvider":{"resolveProvider":false},
  "linkedEditingRangeProvider":true,
  "diagnosticProvider":{"identifier":"gsharp","interFileDependencies":true,"workspaceDiagnostics":false}
}`)
        Assert.True(JsonNode.DeepEquals(expected, actual), actual?.ToJsonString())
    }

    @Fact
    async func EmptyOpenAndSave_AreAppliedByRealHandlers() {
        let documents = DocumentContentService()
        let server = LspServer(documents, WorkspaceState())
        let uri = DocumentUri.From("file:///empty-document.gs")!!
        await server.DidOpenAsync(
            DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: string.Empty}}
        )
        Assert.True(documents.TryGet(uri.ToString(), out var opened))
        Assert.Equal(string.Empty, opened.SyntaxTree.Text.ToString())
        await server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                ContentChanges: List[TextDocumentContentChangeEvent]{
                    TextDocumentContentChangeEvent{Text: "func F() int32 -> 1\n"}
                }
            }
        )
        await server.DidSaveAsync(
            DidSaveTextDocumentParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Text: string.Empty}
        )
        Assert.True(documents.TryGet(uri.ToString(), out var saved))
        Assert.Equal(string.Empty, saved.SyntaxTree.Text.ToString())
    }

    @Fact
    async func PushClient_OpenBeforeDiscovery_IsReboundWithProjectDiagnostics() {
        let root = CreateDirectory()
        try {
            let projectPath = Path.Combine(root, "Sample.gsproj")
            let sourcePath = Path.Combine(root, "Foo.gs")
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
            )
            File.WriteAllText(sourcePath, `class Foo {
  func run() int32 -> Bar().value()
}
`)
            File.WriteAllText(Path.Combine(root, "Bar.gs"), `class Bar {
  func value() int32 -> 1
}
`)
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(sourcePath)!!
            var projectBind DiagnosticComputationResult? = nil
            server.TestOnBindResult = (_ DocumentUri, result DiagnosticComputationResult) -> {
                if result.Content.Project != nil {
                    projectBind = result
                }
            }
            await server.InitializeAsync(InitializeParams{RootPath: root})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: File.ReadAllText(sourcePath)}}
            )
            Assert.Null(workspace.GetProjectForFile(sourcePath))
            using let initializedParams = JsonDocument.Parse("{}")
            server.Initialized(initializedParams.RootElement.Clone())
            await WaitForAsync(() -> Volatile.Read(&projectBind) != nil)
            Assert.Empty(projectBind!!.Diagnostics)
            Assert.Equal(Path.GetFullPath(projectPath), projectBind!!.Content.Project!!.ProjectFilePath)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func WatchedChangedSource_ReloadsProjectTreeFromDisk() {
        let root = CreateDirectory()
        try {
            let projectPath = Path.Combine(root, "Sample.gsproj")
            let sourcePath = Path.Combine(root, "Program.gs")
            File.WriteAllText(projectPath, "<Project />")
            File.WriteAllText(sourcePath, "func Value() int32 -> 1\n")
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, root)
            let project = Assert.Single(workspace.Projects)
            File.WriteAllText(sourcePath, "func Value() int32 -> 2\n")
            let server = LspServer(DocumentContentService(), workspace)
            await NotifyWatchedFileAsync(server, sourcePath, FileChangeType.Changed)
            Assert.True(project.TryGetSyntaxTree(sourcePath, out var tree))
            Assert.Contains("-> 2", tree.Text.ToString(), StringComparison.Ordinal)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func WatchedChangedProject_RefreshesIdentityMetadata() {
        let root = CreateDirectory()
        try {
            let projectPath = Path.Combine(root, "Sample.gsproj")
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><AssemblyName>Before</AssemblyName><TargetFramework>net9.0</TargetFramework><RootNamespace>Before.Root</RootNamespace></PropertyGroup></Project>"
            )
            File.WriteAllText(Path.Combine(root, "Program.gs"), string.Empty)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, root)
            let project = Assert.Single(workspace.Projects)
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><AssemblyName>After</AssemblyName><TargetFramework>net10.0</TargetFramework><RootNamespace>After.Root</RootNamespace></PropertyGroup></Project>"
            )
            let server = LspServer(DocumentContentService(), workspace)
            await NotifyWatchedFileAsync(server, projectPath, FileChangeType.Changed)
            Assert.Same(project, workspace.GetProject(projectPath))
            Assert.Equal("After", project.AssemblyName)
            Assert.Equal("net10.0", project.TargetFramework)
            Assert.Equal("After.Root", project.RootNamespace)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private func NotifyWatchedFileAsync(server LspServer, path string, changeType FileChangeType) Task -> server
            .DidChangeWatchedFilesAsync(
            DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{FileEvent{Uri: DocumentUri.FromFileSystemPath(path)!!, Type: changeType}}
            }
        )

        private func CreateDirectory() string {
            let path = Path.Combine(Path.GetTempPath(), "gsharp-lsp-parity-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private async func WaitForAsync(condition() -> bool, timeoutMs int32 = 10000) {
            let deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs)
            while !condition() {
                if DateTime.UtcNow > deadline {
                    Assert.Fail("Timed out waiting for asynchronous language-server work.")
                }
                await Task.Delay(25)
            }
        }
    }
}
