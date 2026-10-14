// <copyright file="GsgenGeneratedSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

// ADR-0145 §G (v1 slice): generator output (obj/.../gsgen/*.g.gs) must be visible to the
// language server so generated members resolve in the editor after a build. These tests
// exercise both the discovery path (ProjectDiscovery seeds generated parts) and the
// watched-file path (a build's Create/Change/Delete refreshes the owning project).
open class GsgenGeneratedSourceTests {
    @Fact
    func GeneratedPartial_ResolvesMemberInCompilation() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"))
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            // User declares `partial class Foo {}` and uses the generated member `Bar`.
            File.WriteAllText(Path.Combine(tempDir, "Program.gs"), UserSource)
            // Generator output augments Foo with `func Bar()`.
            let gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen")
            Directory.CreateDirectory(gsgenDir)
            File.WriteAllText(Path.Combine(gsgenDir, "Foo.g.gs"), GeneratedSource)
            let discovered DiscoveredProject? = ProjectDiscovery.DiscoverProject(projPath)
            Assert.NotNull(discovered)
            Assert.Contains(
                discovered!!.SourceFiles,
                (f string) -> f.EndsWith("Foo.g.gs", StringComparison.OrdinalIgnoreCase)
            )
            let project = ProjectState(discovered!!.ProjectFilePath)
            for source in discovered!!.SourceFiles {
                project.AddFileFromDisk(source)
            }
            let compilation = project.GetCompilation()
            let diagnostics = compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).ToList()
            // The ADR-0144 partial-type merge makes the generated `Bar` visible to the
            // user's use-site, so `f.Bar()` resolves with no error.
            Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    async func DidChangeWatchedFiles_CreatedGeneratedPart_RefreshesProject() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"))
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            let userSource = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(userSource, UserSource)
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(projPath)
            project.AddFileFromDisk(userSource)
            workspaceState.RegisterFile(userSource, project)
            let server = LspServer(DocumentContentService(), workspaceState)
            // A build writes the generated part and the watcher reports a Created event.
            let gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen")
            Directory.CreateDirectory(gsgenDir)
            let generatedPath = Path.Combine(gsgenDir, "Foo.g.gs")
            File.WriteAllText(generatedPath, GeneratedSource)
            let request = DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{
                    FileEvent{Uri: DocumentUri.FromFileSystemPath(generatedPath)!!, Type: FileChangeType.Created}
                }
            }
            let exception = await Record.ExceptionAsync(() -> server.DidChangeWatchedFilesAsync(request))
            Assert.Null(exception)
            // The generated part is now part of the owning project and its member resolves.
            Assert.True(project.ContainsFile(generatedPath))
            let compilation = project.GetCompilation()
            let diagnostics = compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).ToList()
            Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    async func DidChangeWatchedFiles_DeletedGeneratedPart_RemovesFromProject() {
        let tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"))
        try {
            Directory.CreateDirectory(tempDir)
            let projPath = Path.Combine(tempDir, "Sample.gsproj")
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>")
            let gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen")
            Directory.CreateDirectory(gsgenDir)
            let generatedPath = Path.Combine(gsgenDir, "Foo.g.gs")
            File.WriteAllText(generatedPath, GeneratedSource)
            let workspaceState = WorkspaceState()
            let project = workspaceState.AddProject(projPath)
            project.AddFileFromDisk(generatedPath)
            workspaceState.RegisterFile(generatedPath, project)
            let server = LspServer(DocumentContentService(), workspaceState)
            let request = DidChangeWatchedFilesParams{
                Changes: List[FileEvent]{
                    FileEvent{Uri: DocumentUri.FromFileSystemPath(generatedPath)!!, Type: FileChangeType.Deleted}
                }
            }
            let exception = await Record.ExceptionAsync(() -> server.DidChangeWatchedFilesAsync(request))
            Assert.Null(exception)
            Assert.False(project.ContainsFile(generatedPath))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        private const UserSource string = `partial class Foo {}
let f = Foo()
let r = f.Bar()
`

        private const GeneratedSource string = `partial class Foo {
    func Bar() int32 { return 1 }
}
`
    }
}
