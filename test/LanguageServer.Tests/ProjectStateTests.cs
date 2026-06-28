// <copyright file="ProjectStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
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
        var projectFilePath = "/test/myapp/myapp.gsproj";

        var project = new ProjectState(projectFilePath);
        var expected = Path.GetDirectoryName(Path.GetFullPath(projectFilePath));

        Assert.Equal(expected, project.ProjectDirectory);
    }

    [Fact]
    public void GetCompilation_UsesReferenceResolverWhenReferencesAreSet()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");

        var withoutRefs = project.GetCompilation();
        Assert.Null(withoutRefs.References);

        var bclPath = typeof(object).Assembly.Location;
        project.References = new[] { bclPath };

        var withRefs = project.GetCompilation();
        Assert.NotSame(withoutRefs, withRefs);
        Assert.NotNull(withRefs.References);
        Assert.NotEmpty(withRefs.References.Assemblies);
    }

    [Fact]
    public void SettingIdenticalReferences_DoesNotInvalidateCompilation()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");
        var bclPath = typeof(object).Assembly.Location;
        project.References = new[] { bclPath };

        var first = project.GetCompilation();
        project.References = new[] { bclPath };
        var second = project.GetCompilation();

        Assert.Same(first, second);
    }

    [Fact]
    public void SettingDifferentReferences_InvalidatesCompilation()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");
        project.References = new[] { typeof(object).Assembly.Location };

        var first = project.GetCompilation();
        project.References = new[] { typeof(object).Assembly.Location, typeof(Uri).Assembly.Location };
        var second = project.GetCompilation();

        Assert.NotSame(first, second);
    }

    [Fact]
    public void GetCompilation_RefreshesWhenResponseFileMtimeChanges()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            Directory.CreateDirectory(tempDir);
            var rspPath = Path.Combine(tempDir, "Sample.rsp");
            var bclPath = typeof(object).Assembly.Location;
            File.WriteAllLines(rspPath, new[] { "/r:" + bclPath });

            var project = new ProjectState("/test/project.gsproj");
            project.UpdateFile("/test/file1.gs", "let x = 1\n");
            project.ReferenceSourcePath = rspPath;
            project.References = new[] { bclPath };

            var first = project.GetCompilation();
            Assert.NotNull(first.References);
            Assert.Single(first.References.Assemblies);

            // Rewrite the response file with an additional reference and advance its mtime
            File.WriteAllLines(rspPath, new[] { "/r:" + bclPath, "/r:" + typeof(Uri).Assembly.Location });
            File.SetLastWriteTimeUtc(rspPath, DateTime.UtcNow.AddSeconds(1));

            var second = project.GetCompilation();
            Assert.NotSame(first, second);
            Assert.NotNull(second.References);
            Assert.Equal(2, second.References.Assemblies.Length);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void UpdateFile_WithIdenticalText_PreservesCompilationCache()
    {
        // Hot-path optimization: the LSP re-invokes ComputeDiagnostics (which calls
        // UpdateFile) on every diagnostic / hover / definition pull. When the in-memory
        // text hasn't actually changed, we must NOT invalidate the compilation — otherwise
        // every request re-runs GlobalScope binding (~185ms) and BoundProgram binding
        // (~500ms) on large reference graphs, making the editor borderline unusable.
        var project = new ProjectState("/test/project.gsproj");
        const string text = "func F() int32 { return 1 }\n";
        project.UpdateFile("/test/file1.gs", text);

        var first = project.GetCompilation();
        project.UpdateFile("/test/file1.gs", text);
        var second = project.GetCompilation();

        Assert.Same(first, second);
    }

    [Fact]
    public void UpdateFile_WithChangedText_InvalidatesCompilationCache()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "let x = 1\n");
        var first = project.GetCompilation();

        project.UpdateFile("/test/file1.gs", "let x = 2\n");
        var second = project.GetCompilation();

        Assert.NotSame(first, second);
    }

    [Fact]
    public void Compilation_BoundProgram_IsCachedAcrossAccesses()
    {
        // Mirrors the GlobalScope caching pattern. The language server expects that
        // accessing compilation.BoundProgram twice in a row returns the same instance
        // so that per-LSP-request body binding doesn't repeat the work that already
        // happened on the first access.
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile("/test/file1.gs", "func F() int32 { return 1 }\n");

        var compilation = project.GetCompilation();
        var first = compilation.BoundProgram;
        var second = compilation.BoundProgram;

        Assert.Same(first, second);
    }
}
