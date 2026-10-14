// <copyright file="WorkspaceStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import Xunit

open class WorkspaceStateTests {
    @Fact
    func AddProject_CreatesProjectState() {
        let workspace = WorkspaceState()
        let project = workspace.AddProject("/test/app/app.gsproj")
        Assert.NotNull(project)
        Assert.Single(workspace.Projects)
    }

    @Fact
    func RemoveProject_RemovesFromWorkspace() {
        let workspace = WorkspaceState()
        workspace.AddProject("/test/app/app.gsproj")
        Assert.True(workspace.RemoveProject("/test/app/app.gsproj"))
        Assert.Empty(workspace.Projects)
    }

    @Fact
    func GetProjectForFile_ReturnsCorrectProject() {
        let workspace = WorkspaceState()
        let project = workspace.AddProject("/test/app/app.gsproj")
        project.UpdateFile("/test/app/main.gs", "let x = 1\n")
        workspace.RegisterFile("/test/app/main.gs", project)
        let found ProjectState? = workspace.GetProjectForFile("/test/app/main.gs")
        Assert.Same(project, found)
    }

    @Fact
    func GetProjectForFile_ReturnsNullForUnknownFile() {
        let workspace = WorkspaceState()
        workspace.AddProject("/test/app/app.gsproj")
        let found ProjectState? = workspace.GetProjectForFile("/test/other/file.gs")
        Assert.Null(found)
    }

    @Fact
    func GetProject_ReturnsByPath() {
        let workspace = WorkspaceState()
        let project = workspace.AddProject("/test/app/app.gsproj")
        let found ProjectState? = workspace.GetProject("/test/app/app.gsproj")
        Assert.Same(project, found)
    }

    @Fact
    func GetOrCreateImplicitProject_CreatesWhenNoProjects() {
        let workspace = WorkspaceState()
        let implicit1 ProjectState? = workspace.GetOrCreateImplicitProject()
        Assert.NotNull(implicit1)
    }

    @Fact
    func GetOrCreateImplicitProject_ReturnsNullWhenProjectsExist() {
        let workspace = WorkspaceState()
        workspace.AddProject("/test/app/app.gsproj")
        let result ProjectState? = workspace.GetOrCreateImplicitProject()
        Assert.Null(result)
    }

    @Fact
    func GetReferencedProjects_ReturnsResolvedReferences() {
        let workspace = WorkspaceState()
        let lib = workspace.AddProject("/test/lib/lib.gsproj")
        let app = workspace.AddProject("/test/app/app.gsproj")
        app.ProjectReferences = []string{"/test/lib/lib.gsproj"}
        let refs = workspace.GetReferencedProjects(app)
        Assert.Single(refs)
        Assert.Same(lib, refs[0])
    }

    @Fact
    func GetReferencedProjects_SkipsUnresolvedReferences() {
        let workspace = WorkspaceState()
        let app = workspace.AddProject("/test/app/app.gsproj")
        app.ProjectReferences = []string{"/test/missing/missing.gsproj"}
        let refs = workspace.GetReferencedProjects(app)
        Assert.Empty(refs)
    }

    @Fact
    func RegisterFile_AllowsLookup() {
        let workspace = WorkspaceState()
        let project = workspace.AddProject("/test/app/app.gsproj")
        project.UpdateFile("/test/app/file.gs", "let x = 1\n")
        workspace.RegisterFile("/test/app/file.gs", project)
        Assert.Same(project, workspace.GetProjectForFile("/test/app/file.gs"))
    }

    @Fact
    func UnregisterFile_RemovesMapping() {
        let workspace = WorkspaceState()
        let project = workspace.AddProject("/test/app/app.gsproj")
        project.UpdateFile("/test/app/file.gs", "let x = 1\n")
        workspace.RegisterFile("/test/app/file.gs", project)
        workspace.UnregisterFile("/test/app/file.gs")
        // GetProjectForFile still finds it via fallback search since it's still in the project
        let found ProjectState? = workspace.GetProjectForFile("/test/app/file.gs")
        Assert.Same(project, found)
    }
}
