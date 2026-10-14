// <copyright file="LspServerInitializedDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Diagnostics
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import Nerdbank.Streams
import StreamJsonRpc
import System
import System.IO
import System.Text.Json
import System.Threading.Tasks
import Xunit

/// The LSP "initialized" notification carries a params object ({}). StreamJsonRpc only routes
/// that object to (cref:LspServer.Initialized)'s single `JsonElement` parameter when
/// the handler opts into single-object parameter deserialization (as every other params-taking
/// handler does); without it the notification is silently dropped, so background workspace
/// discovery never runs, no project is ever registered, and every file binds against a
/// project-less compilation (all imported symbols show spurious "could not be found" squiggles).
///
/// The other tests in this suite invoke (cref:LspServer.Initialized) directly, which
/// bypasses JSON-RPC dispatch and cannot catch a wiring regression. This test drives the server
/// over a real StreamJsonRpc connection — exactly as `Program.RunAsync` hosts it — so the
/// "initialized" notification must actually dispatch for the assertion to hold.
open class LspServerInitializedDispatchTests {
    @Theory
    @InlineData("{}")
    @InlineData("{\"rootPath\":null,\"rootUri\":null}")
    @InlineData("{\"rootPath\":\"\",\"rootUri\":null}")
    @InlineData("{\"rootUri\":\"\"}")
    async func NoRootInitialize_OverRpc_CompletesDiscoveryWithoutErrors(initializeJson string) {
        let logPath = Path.Combine(Path.GetTempPath(), "gs-no-root-" + Guid.NewGuid().ToString("N") + ".log")
        try {
            using let logger = FileLogger(logPath)
            let workspace = WorkspaceState()
            let documents = DocumentContentService()
            let server = LspServer(documents, workspace, logger)
            let discovered = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
            server.TestAfterWorkspaceDiscovery = () -> discovered.TrySetResult(true)
            let (clientStream, serverStream) = FullDuplexStream.CreatePair()
            using let serverRpc = JsonRpc(
                HeaderDelimitedMessageHandler(
                    serverStream,
                    serverStream,
                    SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
                )
            )
            serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
            server.Attach(serverRpc)
            serverRpc.StartListening()
            using let clientRpc = JsonRpc(
                HeaderDelimitedMessageHandler(
                    clientStream,
                    clientStream,
                    SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
                )
            )
            clientRpc.StartListening()
            using let initializeParams = JsonDocument.Parse(initializeJson)
            let result = await clientRpc.InvokeWithParameterObjectAsync[InitializeResult](
                "initialize",
                initializeParams.RootElement.Clone()
            )
            Assert.NotNull(result.Capabilities)
            await clientRpc.NotifyWithParameterObjectAsync("initialized", AnonymousType0_E3B0C44298FC1C14())
            await discovered.Task.WaitAsync(TimeSpan.FromSeconds(10))
            Assert.Null(workspace.RootPath)
            Assert.Empty(workspace.Projects)
            // Windows requires the reader to share write access with the still-open logger.
            using let logStream = FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)
            using let logReader = StreamReader(logStream)
            Assert.DoesNotContain("\"Level\":\"Error\"", logReader.ReadToEnd(), StringComparison.Ordinal)
            // Single-file editing must remain usable after the no-root handshake.
            let uri = DocumentUri.FromFileSystemPath(Path.Combine(Path.GetTempPath(), "no-root.gs"))!!
            await clientRpc.InvokeWithParameterObjectAsync(
                "textDocument/didOpen",
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: string.Empty}}
            )
            Assert.True(documents.TryGet(uri.ToString(), out var opened))
            Assert.Equal(string.Empty, opened.SyntaxTree.Text.ToString())
            await clientRpc.InvokeAsync[object]("shutdown")
        } finally {
            File.Delete(logPath)
        }
    }

    @Fact
    async func InitializedNotification_OverRpc_TriggersBackgroundDiscovery() {
        let rootDir = CreateSampleWorkspace()
        try {
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            let (clientStream, serverStream) = FullDuplexStream.CreatePair()
            using let serverRpc = JsonRpc(
                HeaderDelimitedMessageHandler(
                    serverStream,
                    serverStream,
                    SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
                )
            )
            serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
            server.Attach(serverRpc)
            serverRpc.StartListening()
            using let clientRpc = JsonRpc(
                HeaderDelimitedMessageHandler(
                    clientStream,
                    clientStream,
                    SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
                )
            )
            clientRpc.StartListening()
            // Full handshake exactly as a real client performs it: an "initialize" request whose
            // params carry rootPath, followed by an "initialized" notification with an empty
            // params object.
            await clientRpc.InvokeWithParameterObjectAsync[InitializeResult](
                "initialize",
                AnonymousType1_2F956D526F056A8E(rootDir)
            )
            await clientRpc.NotifyWithParameterObjectAsync("initialized", AnonymousType0_E3B0C44298FC1C14())
            // If "initialized" dispatched, background discovery registers the workspace's project.
            await WaitForAsync(() -> workspace.Projects.Count > 0)
            let project = Assert.Single(workspace.Projects)
            Assert.Equal("Demo", project.AssemblyName)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    shared {
        private func CreateSampleWorkspace() string {
            let rootDir = Path.Combine(Path.GetTempPath(), "gsdispatch_" + Guid.NewGuid().ToString("N"))
            let projDir = Path.Combine(rootDir, "Demo")
            Directory.CreateDirectory(projDir)
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(projDir, "Foo.gs"), `class Foo {
  func run() int -> 1
}
`)
            return rootDir
        }

        private async func WaitForAsync(condition() -> bool, timeoutMs int32 = 10000) {
            let deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs)
            while !condition() {
                if DateTime.UtcNow > deadline {
                    Assert.Fail(
                        "Timed out waiting for background discovery — the 'initialized' notification likely did not dispatch."
                    )
                }
                await Task.Delay(25)
            }
        }
    }
}

internal data class AnonymousType0_E3B0C44298FC1C14() { }

internal data class AnonymousType1_2F956D526F056A8E(rootPath string) { }
