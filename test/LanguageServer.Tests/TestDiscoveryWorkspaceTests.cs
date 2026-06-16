// <copyright file="TestDiscoveryWorkspaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Locks in workspace-wide test discovery: the <c>gsharp/discoverTests</c> request must
/// surface every test across all project source files — even files that were never opened
/// in an editor — so the VS Code Test Explorer is populated after a build without the user
/// having to open each file. Open editor buffers are overlaid so in-flight edits win.
/// </summary>
public class TestDiscoveryWorkspaceTests : IDisposable
{
    private readonly string root;

    public TestDiscoveryWorkspaceTests()
    {
        this.root = Path.Combine(Path.GetTempPath(), "gsharp-testdiscovery-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public async Task DiscoverTests_FindsTestsInUnopenedProjectFiles()
    {
        var fileA = this.WriteFile("AlphaTests.gs", "class AlphaTests {\n  @Fact\n  func PassesA() {\n  }\n}\n");
        var fileB = this.WriteFile("BetaTests.gs", "@Test\nfunc TopLevelBeta() {\n}\n");

        var workspace = new WorkspaceState();
        var project = workspace.AddProject(Path.Combine(this.root, "Demo.gsproj"));
        project.TargetFramework = "net10.0";
        foreach (var file in new[] { fileA, fileB })
        {
            project.AddFileFromDisk(file);
            workspace.RegisterFile(file, project);
        }

        // Note: no DidOpenAsync calls — discovery must not depend on open buffers.
        var server = new LspServer(new DocumentContentService(), workspace);

        var tests = await server.DiscoverTestsAsync();

        // Tests are grouped under a single "<project> (<tfm>)" node.
        var group = Assert.Single(tests);
        Assert.Equal("Demo (net10.0)", group.Label);
        Assert.Equal(project.ProjectFilePath, group.ProjectFile);
        Assert.NotNull(group.Children);
        Assert.Contains(group.Children, c => c.Label == "AlphaTests" && c.Children != null && c.Children.Any(m => m.Label == "PassesA"));
        Assert.Contains(group.Children, c => c.Label == "TopLevelBeta");
    }

    [Fact]
    public async Task DiscoverTests_GroupsByProject()
    {
        var dirA = Directory.CreateDirectory(Path.Combine(this.root, "A")).FullName;
        var dirB = Directory.CreateDirectory(Path.Combine(this.root, "B")).FullName;
        var fileA = WriteTo(dirA, "ATests.gs", "@Fact\nfunc InA() {\n}\n");
        var fileB = WriteTo(dirB, "BTests.gs", "@Fact\nfunc InB() {\n}\n");

        var workspace = new WorkspaceState();
        var projectA = workspace.AddProject(Path.Combine(dirA, "A.gsproj"));
        projectA.TargetFramework = "net10.0";
        projectA.AddFileFromDisk(fileA);
        workspace.RegisterFile(fileA, projectA);

        var projectB = workspace.AddProject(Path.Combine(dirB, "B.gsproj"));
        projectB.TargetFramework = "net10.0";
        projectB.AddFileFromDisk(fileB);
        workspace.RegisterFile(fileB, projectB);

        var server = new LspServer(new DocumentContentService(), workspace);

        var tests = await server.DiscoverTestsAsync();

        Assert.Equal(2, tests.Length);
        var groupA = Assert.Single(tests, t => t.Label == "A (net10.0)");
        var groupB = Assert.Single(tests, t => t.Label == "B (net10.0)");
        Assert.Contains(groupA.Children, c => c.Label == "InA");
        Assert.Contains(groupB.Children, c => c.Label == "InB");
    }

    [Fact]
    public async Task DiscoverTests_OpenBufferEditsOverrideDiskContent()
    {
        var file = this.WriteFile("EditableTests.gs", "class EditableTests {\n  @Fact\n  func Original() {\n  }\n}\n");

        var docs = new DocumentContentService();
        var workspace = new WorkspaceState();
        var project = workspace.AddProject(Path.Combine(this.root, "Demo.gsproj"));
        project.AddFileFromDisk(file);
        workspace.RegisterFile(file, project);

        var server = new LspServer(docs, workspace);
        var uri = DocumentUri.FromFileSystemPath(file);

        // Simulate the user typing a brand-new test into the open buffer; discovery must
        // reflect the in-memory edit rather than the (now stale) on-disk content.
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem
            {
                Uri = uri,
                Text = "class EditableTests {\n  @Fact\n  func Original() {\n  }\n\n  @Fact\n  func Added() {\n  }\n}\n",
            },
        });

        var tests = await server.DiscoverTestsAsync();

        var projectGroup = Assert.Single(tests);
        Assert.Equal("Demo", projectGroup.Label);
        var group = Assert.Single(projectGroup.Children, t => t.Label == "EditableTests");
        Assert.NotNull(group.Children);
        Assert.Contains(group.Children, c => c.Label == "Added");
        Assert.Contains(group.Children, c => c.Label == "Original");
    }

    private static string WriteTo(string dir, string name, string content)
    {
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, content);
        return path;
    }

    private string WriteFile(string name, string content)
    {
        var path = Path.Combine(this.root, name);
        File.WriteAllText(path, content);
        return path;
    }
}
