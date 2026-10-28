// <copyright file="WorkspaceDiscoveryDiagnosticRefreshTests.cs" company="GSharp">
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
import System.Threading
import System.Threading.Tasks
import Xunit

/// Background workspace discovery (kicked off in "initialized") races the editor's didOpen:
/// on a cold start the client opens visible files before discovery has registered any project,
/// so a pull-diagnostics client (e.g. VS Code) can pull diagnostics before the file has an owning
/// project. Binding such a file against a project-less compilation reports every imported/BCL
/// symbol as missing. While discovery is pending the server must therefore return syntax-only
/// diagnostics, then refresh and perform the full project-aware bind once discovery completes.
///
/// This test locks in the fix: once background discovery completes, the server replaces each
/// open document snapshot with one attached to its now-discovered project and asks the client
/// to refresh diagnostics. Project-aware requests such as Go-to-Definition then work immediately,
/// and the resulting re-pull clears the spurious diagnostics.
open class WorkspaceDiscoveryDiagnosticRefreshTests {
    @Fact
    async func Issue5035_IndexedMember_ColdOpenAndRepeatedEditsKeepBoundSnapshots() {
        let rootDir = Path.Combine(Directory.GetCurrentDirectory(), "out", "issue5035-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(rootDir)
        let source = `package Repro
import System
class Example {
    prop Address Uri -> Uri("https://example.test/path")
    func Read() {
        let uri = this.Address
        let result = uri.ToString()[0]
    }
}
`
        let path = Path.Combine(rootDir, "Example.gs")
        File.WriteAllText(path, source)
        File.WriteAllText(Path.Combine(rootDir, "Example.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
<PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
        let documents = DocumentContentService()
        let workspace = WorkspaceState()
        let server = LspServer(documents, workspace)
        let stopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let proceed = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        var scheduled = false
        try {
            server.TestBeforeWorkspaceDiscovery = () -> proceed.Task.GetAwaiter().GetResult()
            server.TestAfterWorkspaceDiscovery = () -> stopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir, Capabilities: PullClientCapabilities()})
            let uri = DocumentUri.FromFileSystemPath(path)!!
            let id = TextDocumentIdentifier{Uri: uri}
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: source}})
            Assert.Null(workspace.GetProjectForFile(path))
            using let initialized = JsonDocument.Parse("{}")
            server.Initialized(initialized.RootElement.Clone())
            scheduled = true
            proceed.TrySetResult(true)
            await stopped.Task.WaitAsync(TimeSpan.FromSeconds(30))
            Assert.Empty(await PullDiagnosticsAsync(server, uri))
            Assert.True(documents.TryGet(uri.ToString(), out var snapshot))
            let compilation = snapshot.Project!!.GetCompilation()
            let token = SemanticLookup.FindTokenAt(
                snapshot.SyntaxTree,
                source.IndexOf("ToString", StringComparison.Ordinal)
            )!!
            var version = 1
            for text in[]string{
                source,
                source.Replace("ToString()[0]", "Host[0]"),
                source.Replace("let result =", "\n        let result ="),
                source
            } {
                if version > 1 {
                    await server.DidChangeAsync(
                        DidChangeTextDocumentParams{
                            TextDocument: VersionedTextDocumentIdentifier{Uri: uri, Version: version},
                            ContentChanges: List[TextDocumentContentChangeEvent]{
                                TextDocumentContentChangeEvent{Text: text}
                            }
                        }
                    )
                }
                version++
                Assert.Empty(await PullDiagnosticsAsync(server, uri))
                let method = text.Contains("ToString()[0]", StringComparison.Ordinal)
                let name = if method {
                    "ToString"
                } else {
                    "Host"
                }
                let position = LanguageServerTestHelpers.PositionOf(text, name)
                let hover = Assert.IsType[Hover](
                    await server.HoverAsync(HoverParams{TextDocument: id, Position: position})
                )
                Assert.Equal(
                    if method {
                        "func (System.Uri) ToString() string"
                    } else {
                        "System.Uri.Host string { get; }"
                    },
                    hover.Contents.ToString().Split('\n')[1]
                )
                Assert.Equal(position.Line, hover.Range.Start.Line)
                Assert.Equal(position.Character, hover.Range.Start.Character)
                Assert.Equal(position.Line, hover.Range.End.Line)
                Assert.Equal(position.Character + name.Length, hover.Range.End.Character)
                Assert.True(documents.TryGet(uri.ToString(), out var current))
                let currentCompilation = current.Project!!.GetCompilation()
                if version > 2 {
                    Assert.Same(compilation.GlobalScope, currentCompilation.GlobalScope)
                }
                let currentToken = SemanticLookup.FindTokenAt(
                    current.SyntaxTree,
                    text.IndexOf(name, StringComparison.Ordinal)
                )!!
                Parallel.For(
                    0,
                    8,
                    (_ int32) -> {
                        Assert.Equal(
                            typeof(Uri),
                            BoundSemantics.GetMemberInfo(BoundSemantics.GetImportedSymbol(compilation, token))
                                ?.DeclaringType
                        )
                        Assert.Equal(
                            name,
                            BoundSemantics.GetMemberInfo(
                                BoundSemantics.GetImportedSymbol(currentCompilation, currentToken)
                            )
                                ?.Name
                        )
                        Assert.Contains(snapshot.SyntaxTree, compilation.SyntaxTrees)
                        Assert.Equal(source, snapshot.SyntaxTree.Text.ToString())
                        if !object.ReferenceEquals(current.SyntaxTree, snapshot.SyntaxTree) {
                            Assert.Null(
                                BoundSemantics.GetMemberInfo(
                                    BoundSemantics.GetImportedSymbol(currentCompilation, token)
                                )
                            )
                        }
                    }
                )
            }
            Assert.Equal(source, File.ReadAllText(path))
        } finally {
            server.Shutdown()
            proceed.TrySetResult(true)
            if scheduled {
                await stopped.Task.WaitAsync(TimeSpan.FromSeconds(30))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Theory
    @InlineData(false, false, 0)
    @InlineData(false, false, 1)
    @InlineData(false, true, 0)
    @InlineData(false, true, 1)
    @InlineData(true, false, 0)
    @InlineData(true, false, 1)
    @InlineData(true, true, 0)
    @InlineData(true, true, 1)
    async func LocalHover_DiscoveryAfterOpen_UsesCurrentProjectTree(
        openAfterInitialized bool,
        editDuringDiscovery bool,
        occurrence int32
    ) {
        let rootDir = CreateSampleWorkspace()
        let continueDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let discoveryStopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let documents = DocumentContentService()
        let workspace = WorkspaceState()
        let server = LspServer(documents, workspace)
        var discoveryScheduled = false
        try {
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            File.WriteAllText(fooPath, LocalSource)
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestBeforeWorkspaceDiscovery = () -> {
                discoveryStarted.TrySetResult(true)
                continueDiscovery.Task.GetAwaiter().GetResult()
            }
            server.TestAfterWorkspaceDiscovery = () -> discoveryStopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir, Capabilities: PullClientCapabilities()})
            if !openAfterInitialized {
                await server.DidOpenAsync(
                    DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: LocalSource}}
                )
            }
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            discoveryScheduled = true
            await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(10))
            if openAfterInitialized {
                await server.DidOpenAsync(
                    DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: LocalSource}}
                )
            }
            let source = if editDuringDiscovery {
                LocalSource.Replace("int32", "string").Replace("42", "\"unsaved\"")
            } else {
                LocalSource
            }
            if editDuringDiscovery {
                await server.DidChangeAsync(
                    DidChangeTextDocumentParams{
                        TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                        ContentChanges: List[TextDocumentContentChangeEvent]{
                            TextDocumentContentChangeEvent{Text: source}
                        }
                    }
                )
            }
            Assert.Null(workspace.GetProjectForFile(fooPath))
            continueDiscovery.TrySetResult(true)
            await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            Assert.Empty(await PullDiagnosticsAsync(server, uri))
            let position = LanguageServerTestHelpers.PositionOf(source, "answer", occurrence)
            let hover = Assert.IsType[Hover](
                await server.HoverAsync(HoverParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Position: position})
            )
            let expectedType = if editDuringDiscovery {
                "string"
            } else {
                "int32"
            }
            Assert.Contains(
                "(local variable) answer ${expectedType}",
                hover.Contents.ToString(),
                StringComparison.Ordinal
            )
            Assert.Equal(position.Line, hover.Range.Start.Line)
            Assert.Equal(position.Character, hover.Range.Start.Character)
            Assert.Equal(position.Line, hover.Range.End.Line)
            Assert.Equal(position.Character + "answer".Length, hover.Range.End.Character)
            Assert.True(documents.TryGet(uri.ToString(), out var content))
            let project = Assert.IsType[ProjectState](workspace.GetProjectForFile(fooPath))
            Assert.Same(project, content.Project)
            Assert.Equal(source, content.SyntaxTree.Text.ToString())
            Assert.Equal(fooPath, content.SyntaxTree.Text.FileName)
            Assert.True(project.TryGetSyntaxTree(fooPath, out var tree))
            Assert.Same(tree, content.SyntaxTree)
            Assert.Contains(content.SyntaxTree, project.GetCompilation().SyntaxTrees)
            Assert.Equal(LocalSource, File.ReadAllText(fooPath))
        } finally {
            server.Shutdown()
            continueDiscovery.TrySetResult(true)
            if discoveryScheduled {
                await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func PullClient_DiscoveryAfterOpen_RequestsRefreshAndSubsequentPullIsClean() {
        let rootDir = CreateSampleWorkspace()
        try {
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            var refreshRequested = false
            server.TestOnDiagnosticRefreshAfterDiscovery = () -> {
                refreshRequested = true
            }
            await server.InitializeAsync(InitializeParams{RootPath: rootDir, Capabilities: PullClientCapabilities()})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: FooSource}}
            )
            // A pull that lands before background discovery registers the project must not bind
            // project-less and flash false missing-symbol diagnostics.
            let beforeDiscovery = await PullDiagnosticsAsync(server, uri)
            Assert.Null(workspace.GetProjectForFile(fooPath))
            Assert.Empty(beforeDiscovery)
            // Discovery runs in the background; when it completes the server asks the client to
            // refresh (re-pull) diagnostics for its open documents.
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await WaitForAsync(() -> refreshRequested && workspace.GetProjectForFile(fooPath) != nil)
            let definitions = await server.DefinitionAsync(
                DefinitionParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(FooSource, "Bar")
                }
            )
            let definition = Assert.Single(definitions)
            Assert.EndsWith("Bar.gs", definition.Uri!!.GetFileSystemPath())
            // The refresh-driven re-pull now binds Foo.gs against its project (both source files),
            // so the sibling symbols resolve and the spurious diagnostics are gone.
            let afterDiscovery = await PullDiagnosticsAsync(server, uri)
            Assert.Empty(afterDiscovery)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func ProjectAwareRequestsDuringDiscovery_WaitForProjectAwareContent() {
        let rootDir = CreateSampleWorkspace()
        let continueDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let discoveryStopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        try {
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestBeforeWorkspaceDiscovery = () -> {
                discoveryStarted.TrySetResult(true)
                continueDiscovery.Task.GetAwaiter().GetResult()
            }
            server.TestAfterWorkspaceDiscovery = () -> discoveryStopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: FooSource}}
            )
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(10))
            let definitionTask = server.DefinitionAsync(
                DefinitionParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(FooSource, "Bar")
                }
            )
            let hoverTask = server.HoverAsync(
                HoverParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(FooSource, "Bar")
                }
            )
            try {
                await Task.Delay(100)
                Assert.False(definitionTask.IsCompleted)
                Assert.False(hoverTask.IsCompleted)
            } finally {
                continueDiscovery.TrySetResult(true)
            }
            let definition = Assert.Single(await definitionTask)
            Assert.EndsWith("Bar.gs", definition.Uri!!.GetFileSystemPath())
            Assert.NotNull(await hoverTask)
        } finally {
            continueDiscovery.TrySetResult(true)
            if !discoveryStopped.Task.IsCompleted {
                await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func DefinitionRequestedDuringDiscovery_CompletesOnShutdown() {
        let rootDir = CreateSampleWorkspace()
        let continueDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let discoveryStopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        try {
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestBeforeWorkspaceDiscovery = () -> {
                discoveryStarted.TrySetResult(true)
                continueDiscovery.Task.GetAwaiter().GetResult()
            }
            server.TestAfterWorkspaceDiscovery = () -> discoveryStopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: SameFileDefinitionSource}}
            )
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(10))
            let definitionTask = server.DefinitionAsync(
                DefinitionParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: LanguageServerTestHelpers.PositionOf(SameFileDefinitionSource, "helper", occurrence: 1)
                }
            )
            await Task.Delay(100)
            Assert.False(definitionTask.IsCompleted)
            server.Shutdown()
            Assert.Empty(await definitionTask.WaitAsync(TimeSpan.FromSeconds(10)))
        } finally {
            continueDiscovery.TrySetResult(true)
            if !discoveryStopped.Task.IsCompleted {
                await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func DocumentSymbolsRequestedDuringDiscovery_DoNotWaitForProjectLoading() {
        let rootDir = CreateSampleWorkspace()
        let continueDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let discoveryStopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        try {
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestBeforeWorkspaceDiscovery = () -> {
                discoveryStarted.TrySetResult(true)
                continueDiscovery.Task.GetAwaiter().GetResult()
            }
            server.TestAfterWorkspaceDiscovery = () -> discoveryStopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: FooSource}}
            )
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(10))
            let symbols = await server.DocumentSymbolAsync(
                DocumentSymbolParams{TextDocument: TextDocumentIdentifier{Uri: uri}}
            )
                .WaitAsync(TimeSpan.FromSeconds(10))
            Assert.NotEmpty(symbols)
        } finally {
            continueDiscovery.TrySetResult(true)
            if !discoveryStopped.Task.IsCompleted {
                await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func TestDiscoveryRequestedDuringWorkspaceDiscovery_WaitsForProjectGrouping() {
        let rootDir = CreateSampleWorkspace()
        let continueDiscovery = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let discoveryStopped = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        try {
            File.WriteAllText(Path.Combine(rootDir, "Demo", "Foo.gs"), `@Fact
func Passes() {
}
`)
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let discoveryStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestBeforeWorkspaceDiscovery = () -> {
                discoveryStarted.TrySetResult(true)
                continueDiscovery.Task.GetAwaiter().GetResult()
            }
            server.TestAfterWorkspaceDiscovery = () -> discoveryStopped.TrySetResult(true)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await discoveryStarted.Task.WaitAsync(TimeSpan.FromSeconds(10))
            let testsTask = server.DiscoverTestsAsync()
            await Task.Delay(100)
            Assert.False(testsTask.IsCompleted)
            continueDiscovery.TrySetResult(true)
            let project = Assert.Single(await testsTask)
            Assert.Equal("Demo (net10.0)", project.Label)
            Assert.Equal(Path.Combine(rootDir, "Demo", "Demo.gsproj"), project.ProjectFile)
            Assert.Contains(project.Children!!, (test TestDiscoveryItem) -> test.Label == "Passes")
        } finally {
            continueDiscovery.TrySetResult(true)
            if !discoveryStopped.Task.IsCompleted {
                await discoveryStopped.Task.WaitAsync(TimeSpan.FromSeconds(10))
            }
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func PullClient_DiscoveryFailure_RestoresSemanticDiagnostics() {
        let rootDir = CreateSampleWorkspace()
        try {
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let fooPath = Path.Combine(rootDir, "Demo", "Foo.gs")
            let uri = DocumentUri.FromFileSystemPath(fooPath)!!
            var refreshRequested = false
            server.TestBeforeWorkspaceDiscovery = () -> throw InvalidOperationException("Injected discovery failure.")
            server.TestOnDiagnosticRefreshAfterDiscovery = () -> {
                refreshRequested = true
            }
            await server.InitializeAsync(InitializeParams{RootPath: rootDir, Capabilities: PullClientCapabilities()})
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: FooSource}}
            )
            Assert.Empty(await PullDiagnosticsAsync(server, uri))
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await WaitForAsync(() -> refreshRequested)
            Assert.NotEmpty(await PullDiagnosticsAsync(server, uri))
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func PullClient_ShutdownBeforeDiscoveryCompletion_DoesNotRefresh() {
        let rootDir = CreateSampleWorkspace()
        try {
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let completionReached = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            var refreshRequested = false
            server.TestBeforeWorkspaceDiscoveryCompletion = () -> {
                server.Shutdown()
                completionReached.TrySetResult(true)
            }
            server.TestOnDiagnosticRefreshAfterDiscovery = () -> {
                refreshRequested = true
            }
            await server.InitializeAsync(InitializeParams{RootPath: rootDir, Capabilities: PullClientCapabilities()})
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await completionReached.Task.WaitAsync(TimeSpan.FromSeconds(10))
            await Task.Delay(100)
            Assert.False(refreshRequested)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    shared {
        private const LocalSource string = `class Example {
    func Read() int32 {
        let answer = 42
        return answer
    }
}
`

        // Foo references a type + method defined in a sibling file (Bar.gs) of the SAME project.
        // Bound alone (project-less) both are unresolved; bound with the project they resolve.
        private const BarSource string = `class Bar {
  func hello() int -> 42
}
`

        private const FooSource string = `class Foo {
  func run() int -> Bar().hello()
}
`

        private const SameFileDefinitionSource string = `class Foo {
  func helper() int -> 42
  func run() int -> helper()
}
`

        private func PullClientCapabilities() JsonElement {
            // Advertise textDocument/diagnostic (pull) and workspace diagnostic refreshSupport so the
            // server treats this as a pull client that can be asked to re-pull.
            let doc = JsonDocument.Parse(
                "{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}"
            )
            return doc.RootElement.Clone()
        }

        private async func PullDiagnosticsAsync(server LspServer, uri DocumentUri) IReadOnlyList[Diagnostic] {
            let report = await server.DocumentDiagnosticAsync(
                DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
                CancellationToken.None
            )
            return if report is FullDocumentDiagnosticReport full {
                full.Items
            } else {
                cast[IReadOnlyList[Diagnostic]](Array.Empty[Diagnostic]())
            }
        }

        private func CreateSampleWorkspace() string {
            let rootDir = Path.Combine(Path.GetTempPath(), "gsrefresh_" + Guid.NewGuid().ToString("N"))
            let projDir = Path.Combine(rootDir, "Demo")
            Directory.CreateDirectory(projDir)
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(projDir, "Bar.gs"), BarSource)
            File.WriteAllText(Path.Combine(projDir, "Foo.gs"), FooSource)
            return rootDir
        }

        private async func WaitForAsync(condition() -> bool, timeoutMs int32 = 10000) {
            let deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs)
            while !condition() {
                if DateTime.UtcNow > deadline {
                    Assert.Fail("Timed out waiting for post-discovery diagnostic refresh.")
                }
                await Task.Delay(25)
            }
        }
    }
}
