// <copyright file="Issue1663AsyncWorkspaceInitTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Issue #1663: workspace discovery/parsing must not run inline in the "initialize" request —
/// it should happen in the background after "initialized" so the handshake returns promptly and
/// racing requests degrade gracefully instead of crashing or blocking.
open class Issue1663AsyncWorkspaceInitTests {
    @Fact
    async func InitializeAsync_DoesNotSynchronouslyLoadWorkspaceProjects() {
        let rootDir = CreateSampleWorkspace()
        try {
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            // The "initialize" response must return before any project discovery/parsing runs.
            Assert.Empty(workspace.Projects)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func Initialized_LoadsWorkspaceProjectsInBackground() {
        let rootDir = CreateSampleWorkspace()
        try {
            let workspace = WorkspaceState()
            let server = LspServer(DocumentContentService(), workspace)
            await server.InitializeAsync(InitializeParams{RootPath: rootDir})
            using let doc = JsonDocument.Parse("{}")
            server.Initialized(doc.RootElement.Clone())
            await WaitForAsync(() -> workspace.Projects.Count > 0)
            let project = Assert.Single(workspace.Projects)
            Assert.Equal("Demo", project.AssemblyName)
            let compilation = project.GetCompilation()
            Assert.NotNull(compilation.BoundProgram)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    @Fact
    async func RequestRacingBackgroundLoad_ReturnsEmptyInsteadOfCrashing() {
        let rootDir = CreateSampleWorkspace()
        try {
            let workspace = WorkspaceState()
            // Simulate a request landing before background discovery has registered any files:
            // GetProjectForFile must return null (handled gracefully by callers) rather than throw.
            let project ProjectState? = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"))
            Assert.Null(project)
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let loaded ProjectState? = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"))
            Assert.NotNull(loaded)
        } finally {
            Directory.Delete(rootDir, recursive: true)
        }
    }

    /// Issue #1786 follow-up (B1): the background workspace load must never clobber a client's
    /// open buffer with stale disk text, no matter how didOpen/didChange interleaves with
    /// discovery reaching that file. Runs the real "initialized" background-load path
    /// concurrently with didOpen/didChange on the same file, many times, to flush out both
    /// documented races (client edits before discovery registers the project; client edits
    /// after discovery registers the project but before it visits the file).
    @Fact
    async func BackgroundLoadRacingDidOpen_ClientBufferAlwaysWinsOverDisk() {
        const diskText = `func foo() {
  var x = 1
}
`
        const bufferText = `func foo() {
  var x = 2 // edited by client
}
`
        for var iteration = 0; iteration < 25; iteration++ {
            let rootDir = CreateSampleWorkspace(diskText)
            try {
                let workspace = WorkspaceState()
                let server = LspServer(DocumentContentService(), workspace)
                let filePath = Path.Combine(rootDir, "Demo", "Foo.gs")
                let uri = DocumentUri.FromFileSystemPath(filePath)!!
                await server.InitializeAsync(InitializeParams{RootPath: rootDir})
                // Kick off the real background load and, concurrently, hammer didOpen/didChange
                // for the same file with different text than what's on disk.
                using let doc = JsonDocument.Parse("{}")
                let initializedTask = Task.Run(() -> server.Initialized(doc.RootElement.Clone()))
                let editTask = Task.Run(
                    async () -> {
                        await server.DidOpenAsync(
                            DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: bufferText}}
                        )
                        for var i = 0; i < 10; i++ {
                            await server.DidChangeAsync(
                                DidChangeTextDocumentParams{
                                    TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                                    ContentChanges: List[TextDocumentContentChangeEvent]{
                                        TextDocumentContentChangeEvent{Text: bufferText}
                                    }
                                }
                            )
                        }
                    }
                )
                await Task.WhenAll(initializedTask, editTask)
                await WaitForAsync(() -> workspace.GetProjectForFile(filePath) != nil)
                // Give the background load's per-file registration a moment to fully settle
                // (it may still be mid-flight for other files/projects, but this workspace has
                // only one file).
                await WaitForAsync(
                    () -> {
                        let proj ProjectState? = workspace.GetProjectForFile(filePath)
                        return proj != nil && proj.TryGetSyntaxTree(filePath, out var t) &&
                            t
                            .Text
                            .ToString() == bufferText
                    }
                )
                let loadedProject ProjectState? = workspace.GetProjectForFile(filePath)
                Assert.NotNull(loadedProject)
                Assert.True(loadedProject!!.TryGetSyntaxTree(filePath, out var syntaxTree))
                Assert.Equal(bufferText, syntaxTree.Text.ToString())
            } finally {
                Directory.Delete(rootDir, recursive: true)
            }
        }
    }

    shared {
        private func CreateSampleWorkspace(sourceText string = `func foo() {
  var x = 1
}
`) string {
            let rootDir = Path.Combine(Path.GetTempPath(), "gsinit_" + Guid.NewGuid().ToString("N"))
            let projDir = Path.Combine(rootDir, "Demo")
            Directory.CreateDirectory(projDir)
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(projDir, "Foo.gs"), sourceText)
            return rootDir
        }

        private async func WaitForAsync(condition() -> bool, timeoutMs int32 = 10000) {
            let deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs)
            while !condition() {
                if DateTime.UtcNow > deadline {
                    Assert.Fail("Timed out waiting for background workspace load to complete.")
                }
                await Task.Delay(25)
            }
        }
    }
}
