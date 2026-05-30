// <copyright file="ProjectStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class ProjectStateTests
{
    [Fact]
    public void UpdateFile_AddsSyntaxTree()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        Assert.Single(project.SourceFiles);
        Assert.True(project.ContainsFile("/test/file1.gs"));
    }

    [Fact]
    public void UpdateFile_ReplacesExistingTree()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");
        project.UpdateFile("/test/file1.gs", "let x = 2\n");

        Assert.Single(project.SourceFiles);
    }

    [Fact]
    public void RemoveFile_RemovesFromProject()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        Assert.True(project.RemoveFile("/test/file1.gs"));
        Assert.Empty(project.SourceFiles);
        Assert.False(project.ContainsFile("/test/file1.gs"));
    }

    [Fact]
    public void RemoveFile_ReturnsFalseWhenNotFound()
    {
        var project = new ProjectState("/test/project.gsproj");

        Assert.False(project.RemoveFile("/test/missing.gs"));
    }

    [Fact]
    public void GetCompilation_ReturnsCachedWhenNotDirty()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        var comp1 = project.GetCompilation();
        var comp2 = project.GetCompilation();

        Assert.Same(comp1, comp2);
    }

    [Fact]
    public void GetCompilation_InvalidatesOnFileChange()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        var comp1 = project.GetCompilation();
        project.UpdateFile("/test/file1.gs", "let x = 2\n");
        var comp2 = project.GetCompilation();

        Assert.NotSame(comp1, comp2);
    }

    [Fact]
    public void GetCompilation_IncludesAllFiles()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "func greet() string { return \"hello\" }\n");
        project.UpdateFile("/test/file2.gs", "let msg = greet()\n");

        var compilation = project.GetCompilation();

        // Should compile without errors since both files are included
        Assert.Equal(2, compilation.SyntaxTrees.Length);
    }

    [Fact]
    public void TryGetSyntaxTree_ReturnsTrueForExistingFile()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        Assert.True(project.TryGetSyntaxTree("/test/file1.gs", out var tree));
        Assert.NotNull(tree);
    }

    [Fact]
    public void TryGetSyntaxTree_ReturnsFalseForMissingFile()
    {
        var project = new ProjectState("/test/project.gsproj");

        Assert.False(project.TryGetSyntaxTree("/test/missing.gs", out _));
    }

    [Fact]
    public void ProjectDirectory_DerivedFromProjectFilePath()
    {
        var project = new ProjectState("/test/myapp/myapp.gsproj");

        Assert.Equal("/test/myapp", project.ProjectDirectory);
    }
}
