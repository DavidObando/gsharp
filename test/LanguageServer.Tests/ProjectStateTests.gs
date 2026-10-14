// <copyright file="ProjectStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import System
import System.IO
import System.Threading
import Xunit

open class ProjectStateTests {
    @Fact
    func UpdateFile_AddsSyntaxTree() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        Assert.Single(project.SourceFiles)
        Assert.True(project.ContainsFile("/test/file1.gs"))
    }

    @Fact
    func UpdateFile_ReplacesExistingTree() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        project.UpdateFile("/test/file1.gs", "let x = 2\n")
        Assert.Single(project.SourceFiles)
    }

    @Fact
    func RemoveFile_RemovesFromProject() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        Assert.True(project.RemoveFile("/test/file1.gs"))
        Assert.Empty(project.SourceFiles)
        Assert.False(project.ContainsFile("/test/file1.gs"))
    }

    @Fact
    func RemoveFile_ReturnsFalseWhenNotFound() {
        let project = ProjectState("/test/project.gsproj")
        Assert.False(project.RemoveFile("/test/missing.gs"))
    }

    @Fact
    func GetCompilation_ReturnsCachedWhenNotDirty() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        let comp1 = project.GetCompilation()
        let comp2 = project.GetCompilation()
        Assert.Same(comp1, comp2)
    }

    @Fact
    func GetCompilation_InvalidatesOnFileChange() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        let comp1 = project.GetCompilation()
        project.UpdateFile("/test/file1.gs", "let x = 2\n")
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1, comp2)
    }

    @Fact
    func GetCompilation_IncludesAllFiles() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "func greet() string { return \"hello\" }\n")
        project.UpdateFile("/test/file2.gs", "let msg = greet()\n")
        let compilation = project.GetCompilation()
        // Should compile without errors since both files are included
        Assert.Equal(2, compilation.SyntaxTrees.Length)
    }

    @Fact
    func TryGetSyntaxTree_ReturnsTrueForExistingFile() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        Assert.True(project.TryGetSyntaxTree("/test/file1.gs", out var tree))
        Assert.NotNull(tree)
    }

    @Fact
    func TryGetSyntaxTree_ReturnsFalseForMissingFile() {
        let project = ProjectState("/test/project.gsproj")
        Assert.False(project.TryGetSyntaxTree("/test/missing.gs", out _))
    }

    @Fact
    func ProjectDirectory_DerivedFromProjectFilePath() {
        let projectFilePath = "/test/myapp/myapp.gsproj"
        let project = ProjectState(projectFilePath)
        let expected string? = Path.GetDirectoryName(Path.GetFullPath(projectFilePath))
        Assert.Equal(expected, project.ProjectDirectory)
    }

    @Fact
    func GetCompilation_UsesReferenceResolverWhenReferencesAreSet() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        let withoutRefs = project.GetCompilation()
        Assert.Null(withoutRefs.References)
        let bclPath = typeof(object).Assembly.Location
        project.References = []string{bclPath}
        let withRefs = project.GetCompilation()
        Assert.NotSame(withoutRefs, withRefs)
        Assert.NotNull(withRefs.References)
        Assert.NotEmpty(withRefs.References!!.Assemblies)
    }

    @Fact
    func SettingIdenticalReferences_DoesNotInvalidateCompilation() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        let bclPath = typeof(object).Assembly.Location
        project.References = []string{bclPath}
        let first = project.GetCompilation()
        project.References = []string{bclPath}
        let second = project.GetCompilation()
        Assert.Same(first, second)
    }

    @Fact
    func SettingDifferentReferences_InvalidatesCompilation() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        project.References = []string{typeof(object).Assembly.Location}
        let first = project.GetCompilation()
        project.References = []string{typeof(object).Assembly.Location, typeof(Uri).Assembly.Location}
        let second = project.GetCompilation()
        Assert.NotSame(first, second)
    }

    @Fact
    func GetCompilation_RefreshesWhenResponseFileMtimeChanges() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let rspPath = Path.Combine(tempDir, "Sample.rsp")
            let bclPath = typeof(object).Assembly.Location
            File.WriteAllLines(rspPath, []string{"/r:" + bclPath})
            let project = ProjectState("/test/project.gsproj")
            project.UpdateFile("/test/file1.gs", "let x = 1\n")
            project.ReferenceSourcePath = rspPath
            project.References = []string{bclPath}
            let first = project.GetCompilation()
            Assert.NotNull(first.References)
            Assert.Single(first.References!!.Assemblies)
            // Rewrite the response file with an additional reference and advance its mtime
            File.WriteAllLines(rspPath, []string{"/r:" + bclPath, "/r:" + typeof(Uri).Assembly.Location})
            File.SetLastWriteTimeUtc(rspPath, DateTime.UtcNow.AddSeconds(1.0))
            let second = project.GetCompilation()
            Assert.NotSame(first, second)
            Assert.NotNull(second.References)
            Assert.Equal(2, second.References!!.Assemblies.Length)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func GetCompilation_DiscoversResponseFileCreatedAfterProjectLoad() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let projectPath = Path.Combine(tempDir, "Sample.gsproj")
            let sourcePath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(projectPath, "<Project Sdk=\"Gsharp.NET.Sdk\" />")
            File.WriteAllText(sourcePath, `import System
var value = Uri("https://example.com")
`)
            let project = ProjectState(projectPath)
            project.AssemblyName = "Sample"
            project.AddFileFromDisk(sourcePath)
            let first = project.GetCompilation()
            let rspDir = Path.Combine(tempDir, "obj", "Debug", "net10.0")
            Directory.CreateDirectory(rspDir)
            File.WriteAllLines(Path.Combine(rspDir, "Sample.rsp"), []string{"/r:" + typeof(Uri).Assembly.Location})
            Thread.Sleep(1100)
            let second = project.GetCompilation()
            Assert.NotSame(first, second)
            Assert.NotNull(second.References)
            Assert.Single(second.References!!.Assemblies)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func UpdateFile_WithIdenticalText_PreservesCompilationCache() {
        // Hot-path optimization: the LSP re-invokes ComputeDiagnostics (which calls
        // UpdateFile) on every diagnostic / hover / definition pull. When the in-memory
        // text hasn't actually changed, we must NOT invalidate the compilation — otherwise
        // every request re-runs GlobalScope binding (~185ms) and BoundProgram binding
        // (~500ms) on large reference graphs, making the editor borderline unusable.
        let project = ProjectState("/test/project.gsproj")
        const text = "func F() int32 { return 1 }\n"
        project.UpdateFile("/test/file1.gs", text)
        let first = project.GetCompilation()
        project.UpdateFile("/test/file1.gs", text)
        let second = project.GetCompilation()
        Assert.Same(first, second)
    }

    @Fact
    func UpdateFile_WithChangedText_InvalidatesCompilationCache() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "let x = 1\n")
        let first = project.GetCompilation()
        project.UpdateFile("/test/file1.gs", "let x = 2\n")
        let second = project.GetCompilation()
        Assert.NotSame(first, second)
    }

    @Fact
    func Compilation_BoundProgram_IsCachedAcrossAccesses() {
        // Mirrors the GlobalScope caching pattern. The language server expects that
        // accessing compilation.BoundProgram twice in a row returns the same instance
        // so that per-LSP-request body binding doesn't repeat the work that already
        // happened on the first access.
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile("/test/file1.gs", "func F() int32 { return 1 }\n")
        let compilation = project.GetCompilation()
        let first = compilation.BoundProgram
        let second = compilation.BoundProgram
        Assert.Same(first, second)
    }
}
