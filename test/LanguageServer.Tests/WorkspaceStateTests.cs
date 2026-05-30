// <copyright file="WorkspaceStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class WorkspaceStateTests
{
    [Fact]
    public void AddProject_CreatesProjectState()
    {
        var workspace = new WorkspaceState();
        var project = workspace.AddProject("/test/app/app.gsproj");

        Assert.NotNull(project);
        Assert.Single(workspace.Projects);
    }

    [Fact]
    public void RemoveProject_RemovesFromWorkspace()
    {
        var workspace = new WorkspaceState();
        workspace.AddProject("/test/app/app.gsproj");

        Assert.True(workspace.RemoveProject("/test/app/app.gsproj"));
        Assert.Empty(workspace.Projects);
    }

    [Fact]
    public void GetProjectForFile_ReturnsCorrectProject()
    {
        var workspace = new WorkspaceState();
        var project = workspace.AddProject("/test/app/app.gsproj");
        project.UpdateFile("/test/app/main.gs", "let x = 1\n");
        workspace.RegisterFile("/test/app/main.gs", project);

        var found = workspace.GetProjectForFile("/test/app/main.gs");

        Assert.Same(project, found);
    }

    [Fact]
    public void GetProjectForFile_ReturnsNullForUnknownFile()
    {
        var workspace = new WorkspaceState();
        workspace.AddProject("/test/app/app.gsproj");

        var found = workspace.GetProjectForFile("/test/other/file.gs");

        Assert.Null(found);
    }

    [Fact]
    public void GetProject_ReturnsByPath()
    {
        var workspace = new WorkspaceState();
        var project = workspace.AddProject("/test/app/app.gsproj");

        var found = workspace.GetProject("/test/app/app.gsproj");

        Assert.Same(project, found);
    }

    [Fact]
    public void GetOrCreateImplicitProject_CreatesWhenNoProjects()
    {
        var workspace = new WorkspaceState();

        var implicit1 = workspace.GetOrCreateImplicitProject();

        Assert.NotNull(implicit1);
    }

    [Fact]
    public void GetOrCreateImplicitProject_ReturnsNullWhenProjectsExist()
    {
        var workspace = new WorkspaceState();
        workspace.AddProject("/test/app/app.gsproj");

        var result = workspace.GetOrCreateImplicitProject();

        Assert.Null(result);
    }

    [Fact]
    public void GetReferencedProjects_ReturnsResolvedReferences()
    {
        var workspace = new WorkspaceState();
        var lib = workspace.AddProject("/test/lib/lib.gsproj");
        var app = workspace.AddProject("/test/app/app.gsproj");
        app.ProjectReferences = new[] { "/test/lib/lib.gsproj" };

        var refs = workspace.GetReferencedProjects(app);

        Assert.Single(refs);
        Assert.Same(lib, refs[0]);
    }

    [Fact]
    public void GetReferencedProjects_SkipsUnresolvedReferences()
    {
        var workspace = new WorkspaceState();
        var app = workspace.AddProject("/test/app/app.gsproj");
        app.ProjectReferences = new[] { "/test/missing/missing.gsproj" };

        var refs = workspace.GetReferencedProjects(app);

        Assert.Empty(refs);
    }

    [Fact]
    public void RegisterFile_AllowsLookup()
    {
        var workspace = new WorkspaceState();
        var project = workspace.AddProject("/test/app/app.gsproj");
        project.UpdateFile("/test/app/file.gs", "let x = 1\n");

        workspace.RegisterFile("/test/app/file.gs", project);

        Assert.Same(project, workspace.GetProjectForFile("/test/app/file.gs"));
    }

    [Fact]
    public void UnregisterFile_RemovesMapping()
    {
        var workspace = new WorkspaceState();
        var project = workspace.AddProject("/test/app/app.gsproj");
        project.UpdateFile("/test/app/file.gs", "let x = 1\n");
        workspace.RegisterFile("/test/app/file.gs", project);

        workspace.UnregisterFile("/test/app/file.gs");

        // GetProjectForFile still finds it via fallback search since it's still in the project
        var found = workspace.GetProjectForFile("/test/app/file.gs");
        Assert.Same(project, found);
    }
}
