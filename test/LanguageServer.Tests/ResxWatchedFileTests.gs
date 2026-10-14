// <copyright file="ResxWatchedFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Threading.Tasks
import Xunit

// Issue #2200: saving/creating a .resx within a gsproj's scope should regenerate its
// Resources.Designer.gs codebehind (ADR-0142) via the shared GSharp.Core.Resx generator.
// These tests exercise the behavior through the same public LSP entry point
// (workspace/didChangeWatchedFiles) that the client's file watcher drives.
open class ResxWatchedFileTests {
    @Fact
    async func DidChangeWatchedFiles_Created_GeneratesDesignerFile() {
        let (root, _, designerPath) = await RunAsync(FileChangeType.Created)
        try {
            Assert.True(File.Exists(designerPath))
            let text = File.ReadAllText(designerPath)
            Assert.Contains("Greeting", text)
            Assert.Contains("Sample.App.Properties", text)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func DidChangeWatchedFiles_Changed_RegeneratesDesignerFile() {
        let (root, resxPath, designerPath) = await RunAsync(FileChangeType.Created)
        try {
            Assert.True(File.Exists(designerPath))
            const updatedResx = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Greeting" xml:space="preserve">
    <value>Hello, world!</value>
  </data>
  <data name="Farewell" xml:space="preserve">
    <value>Goodbye!</value>
  </data>
</root>`
            File.WriteAllText(resxPath, updatedResx)
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(Path.Combine(root, "Sample.gsproj"))
            project.RootNamespace = "Sample.App"
            let server = LspServer(DocumentContentService(), workspaceState)
            let request = DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{
                    FileEvent{Uri: DocumentUri.FromFileSystemPath(resxPath)!!, Type: FileChangeType.Changed}
                }
            }
            await server.DidChangeWatchedFilesAsync(request)
            let text = File.ReadAllText(designerPath)
            Assert.Contains("Greeting", text)
            Assert.Contains("Farewell", text)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func DidChangeWatchedFiles_Deleted_LeavesExistingDesignerFileUntouched() {
        let (root, _, designerPath) = await RunAsync(FileChangeType.Created)
        try {
            Assert.True(File.Exists(designerPath))
            let before = File.ReadAllText(designerPath)
            let workspaceState = WorkspaceState()
            workspaceState.AddProject(Path.Combine(root, "Sample.gsproj"))
            let server = LspServer(DocumentContentService(), workspaceState)
            let request = DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{
                    FileEvent{
                        Uri: DocumentUri.FromFileSystemPath(Path.Combine(root, "Properties", "Resources.resx"))!!,
                        Type: FileChangeType.Deleted
                    }
                }
            }
            await server.DidChangeWatchedFilesAsync(request)
            Assert.True(File.Exists(designerPath))
            Assert.Equal(before, File.ReadAllText(designerPath))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func DidChangeWatchedFiles_MalformedResx_DoesNotThrow() {
        let root = Path.Combine(Path.GetTempPath(), "gsharp-resx-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let projectPath = Path.Combine(root, "Sample.gsproj")
        File.WriteAllText(projectPath, "<Project></Project>")
        let resxPath = Path.Combine(root, "Broken.resx")
        File.WriteAllText(resxPath, "<root><data name=\"X\"><value>unterminated")
        let workspaceState = WorkspaceState()
        let project = workspaceState.AddProject(projectPath)
        project.RootNamespace = "Sample.App"
        let server = LspServer(DocumentContentService(), workspaceState)
        let request = DidChangeWatchedFilesParams{
            Changes: List[FileEvent]{
                FileEvent{Uri: DocumentUri.FromFileSystemPath(resxPath)!!, Type: FileChangeType.Created}
            }
        }
        try {
            // Malformed XML must be swallowed by HandleResxFileChange rather than
            // crashing the didChangeWatchedFiles handler for the whole batch.
            let exception = await Record.ExceptionAsync(() -> server.DidChangeWatchedFilesAsync(request))
            Assert.Null(exception)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const SampleResx string = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Greeting" xml:space="preserve">
    <value>Hello, world!</value>
  </data>
</root>`

        private async func RunAsync(changeType FileChangeType, beforeDispatch((string, string) -> void)? = nil)(
            ProjectDir string,
            ResxPath string,
            DesignerPath string
        ) {
            let root = Path.Combine(Path.GetTempPath(), "gsharp-resx-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            let projectPath = Path.Combine(root, "Sample.gsproj")
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><RootNamespace>Sample.App</RootNamespace></PropertyGroup></Project>"
            )
            let resxDir = Path.Combine(root, "Properties")
            Directory.CreateDirectory(resxDir)
            let resxPath = Path.Combine(resxDir, "Resources.resx")
            File.WriteAllText(resxPath, SampleResx)
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(projectPath)
            project.RootNamespace = "Sample.App"
            let server = LspServer(DocumentContentService(), workspaceState)
            beforeDispatch?(root, resxPath)
            let request = DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{FileEvent{Uri: DocumentUri.FromFileSystemPath(resxPath)!!, Type: changeType}}
            }
            await server.DidChangeWatchedFilesAsync(request)
            let designerPath = Path.Combine(resxDir, "Resources.Designer.gs")
            return (root, resxPath, designerPath)
        }
    }
}
