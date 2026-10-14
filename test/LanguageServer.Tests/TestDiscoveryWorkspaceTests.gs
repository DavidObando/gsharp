// <copyright file="TestDiscoveryWorkspaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Locks in workspace-wide test discovery: the `gsharp/discoverTests` request must
/// surface every test across all project source files — even files that were never opened
/// in an editor — so the VS Code Test Explorer is populated after a build without the user
/// having to open each file. Open editor buffers are overlaid so in-flight edits win.
open class TestDiscoveryWorkspaceTests : IDisposable {
    private let root string

    init() {
        this.root = Path.Combine(Path.GetTempPath(), "gsharp-testdiscovery-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.root)
    }

    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (IOException) { }
    }

    @Fact
    async func DiscoverTests_FindsTestsInUnopenedProjectFiles() {
        let fileA = this.WriteFile("AlphaTests.gs", `class AlphaTests {
  @Fact
  func PassesA() {
  }
}
`)
        let fileB = this.WriteFile("BetaTests.gs", `@Test
func TopLevelBeta() {
}
`)
        let workspace = WorkspaceState()
        let project = workspace.AddProject(Path.Combine(this.root, "Demo.gsproj"))
        project.TargetFramework = "net10.0"
        for file in[]string{fileA, fileB} {
            project.AddFileFromDisk(file)
            workspace.RegisterFile(file, project)
        }
        // Note: no DidOpenAsync calls — discovery must not depend on open buffers.
        let server = LspServer(DocumentContentService(), workspace)
        let tests = await server.DiscoverTestsAsync()
        // Tests are grouped under a single "<project> (<tfm>)" node.
        let group = Assert.Single(tests)
        Assert.Equal("Demo (net10.0)", group.Label)
        Assert.Equal(project.ProjectFilePath, group.ProjectFile)
        Assert.NotNull(group.Children)
        Assert.Contains(
            group.Children!!,
            (c TestDiscoveryItem) -> c.Label == "AlphaTests" && c.Children != nil && c.Children!!.Any(
                (m TestDiscoveryItem) -> m.Label == "PassesA"
            )
        )
        Assert.Contains(group.Children!!, (c TestDiscoveryItem) -> c.Label == "TopLevelBeta")
    }

    @Fact
    async func DiscoverTests_GroupsByProject() {
        let dirA = Directory.CreateDirectory(Path.Combine(this.root, "A")).FullName
        let dirB = Directory.CreateDirectory(Path.Combine(this.root, "B")).FullName
        let fileA = WriteTo(dirA, "ATests.gs", `@Fact
func InA() {
}
`)
        let fileB = WriteTo(dirB, "BTests.gs", `@Fact
func InB() {
}
`)
        let workspace = WorkspaceState()
        let projectA = workspace.AddProject(Path.Combine(dirA, "A.gsproj"))
        projectA.TargetFramework = "net10.0"
        projectA.AddFileFromDisk(fileA)
        workspace.RegisterFile(fileA, projectA)
        let projectB = workspace.AddProject(Path.Combine(dirB, "B.gsproj"))
        projectB.TargetFramework = "net10.0"
        projectB.AddFileFromDisk(fileB)
        workspace.RegisterFile(fileB, projectB)
        let server = LspServer(DocumentContentService(), workspace)
        let tests = await server.DiscoverTestsAsync()
        Assert.Equal(2, tests.Length)
        let groupA = Assert.Single(tests, (t TestDiscoveryItem) -> t.Label == "A (net10.0)")
        let groupB = Assert.Single(tests, (t TestDiscoveryItem) -> t.Label == "B (net10.0)")
        Assert.Contains(groupA.Children!!, (c TestDiscoveryItem) -> c.Label == "InA")
        Assert.Contains(groupB.Children!!, (c TestDiscoveryItem) -> c.Label == "InB")
    }

    @Fact
    async func DiscoverTests_NestedProjectOwnsFilesAlsoMatchedByParentGlob() {
        let nestedDir = Directory.CreateDirectory(Path.Combine(this.root, "Nested")).FullName
        let file = WriteTo(nestedDir, "NestedTests.gs", `@Fact
func NestedTest() {
}
`)
        let workspace = WorkspaceState()
        let nested = workspace.AddProject(Path.Combine(nestedDir, "Nested.gsproj"))
        nested.AddFileFromDisk(file)
        workspace.RegisterFile(file, nested)
        let parent = workspace.AddProject(Path.Combine(this.root, "Parent.gsproj"))
        parent.AddFileFromDisk(file)
        workspace.RegisterFile(file, parent)
        let server = LspServer(DocumentContentService(), workspace)
        let tests = await server.DiscoverTestsAsync()
        let group = Assert.Single(tests)
        Assert.Equal("Nested", group.Label)
        Assert.Equal(nested.ProjectFilePath, group.ProjectFile)
        Assert.Contains(group.Children!!, (test TestDiscoveryItem) -> test.Label == "NestedTest")
    }

    @Fact
    async func CreatedFile_IsAssignedToNearestNestedProject() {
        let nestedDir = Directory.CreateDirectory(Path.Combine(this.root, "Nested")).FullName
        let file = WriteTo(nestedDir, "NewTest.gs", `@Fact
func NewTest() {
}
`)
        let workspace = WorkspaceState()
        workspace.AddProject(Path.Combine(this.root, "Parent.gsproj"))
        let nested = workspace.AddProject(Path.Combine(nestedDir, "Nested.gsproj"))
        let server = LspServer(DocumentContentService(), workspace)
        await server.DidChangeWatchedFilesAsync(
            DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{
                    FileEvent{Uri: DocumentUri.FromFileSystemPath(file)!!, Type: FileChangeType.Created}
                }
            }
        )
        Assert.Same(nested, workspace.GetProjectForFile(file))
        Assert.True(nested.ContainsFile(file))
    }

    @Fact
    async func DiscoverTests_OpenBufferEditsOverrideDiskContent() {
        let file = this.WriteFile("EditableTests.gs", `class EditableTests {
  @Fact
  func Original() {
  }
}
`)
        let docs = DocumentContentService()
        let workspace = WorkspaceState()
        let project = workspace.AddProject(Path.Combine(this.root, "Demo.gsproj"))
        project.AddFileFromDisk(file)
        workspace.RegisterFile(file, project)
        let server = LspServer(docs, workspace)
        let uri = DocumentUri.FromFileSystemPath(file)!!
        // Simulate the user typing a brand-new test into the open buffer; discovery must
        // reflect the in-memory edit rather than the (now stale) on-disk content.
        await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: `class EditableTests {
  @Fact
  func Original() {
  }

  @Fact
  func Added() {
  }
}
`}})
        let tests = await server.DiscoverTestsAsync()
        let projectGroup = Assert.Single(tests)
        Assert.Equal("Demo", projectGroup.Label)
        let group = Assert.Single(projectGroup.Children!!, (t TestDiscoveryItem) -> t.Label == "EditableTests")
        Assert.NotNull(group.Children)
        Assert.Contains(group.Children!!, (c TestDiscoveryItem) -> c.Label == "Added")
        Assert.Contains(group.Children!!, (c TestDiscoveryItem) -> c.Label == "Original")
    }

    private func WriteFile(name string, content string) string {
        let path = Path.Combine(this.root, name)
        File.WriteAllText(path, content)
        return path
    }

    shared {
        private func WriteTo(dir string, name string, content string) string {
            let path = Path.Combine(dir, name)
            File.WriteAllText(path, content)
            return path
        }
    }
}
