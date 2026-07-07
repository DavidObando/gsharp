// <copyright file="GsgenGeneratedSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

// ADR-0145 §G (v1 slice): generator output (obj/.../gsgen/*.g.gs) must be visible to the
// language server so generated members resolve in the editor after a build. These tests
// exercise both the discovery path (ProjectDiscovery seeds generated parts) and the
// watched-file path (a build's Create/Change/Delete refreshes the owning project).
public class GsgenGeneratedSourceTests
{
    private const string UserSource =
        "partial class Foo {}\nlet f = Foo()\nlet r = f.Bar()\n";

    private const string GeneratedSource =
        "partial class Foo {\n    func Bar() int32 { return 1 }\n}\n";

    [Fact]
    public void GeneratedPartial_ResolvesMemberInCompilation()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            // User declares `partial class Foo {}` and uses the generated member `Bar`.
            File.WriteAllText(Path.Combine(tempDir, "Program.gs"), UserSource);

            // Generator output augments Foo with `func Bar()`.
            var gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen");
            Directory.CreateDirectory(gsgenDir);
            File.WriteAllText(Path.Combine(gsgenDir, "Foo.g.gs"), GeneratedSource);

            var discovered = ProjectDiscovery.DiscoverProject(projPath);
            Assert.NotNull(discovered);
            Assert.Contains(discovered.SourceFiles, f => f.EndsWith("Foo.g.gs", StringComparison.OrdinalIgnoreCase));

            var project = new ProjectState(discovered.ProjectFilePath);
            foreach (var source in discovered.SourceFiles)
            {
                project.AddFileFromDisk(source);
            }

            var compilation = project.GetCompilation();
            var diagnostics = compilation.GlobalScope.Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList();

            // The ADR-0144 partial-type merge makes the generated `Bar` visible to the
            // user's use-site, so `f.Bar()` resolves with no error.
            Assert.DoesNotContain(diagnostics, d => d.IsError);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public async Task DidChangeWatchedFiles_CreatedGeneratedPart_RefreshesProject()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            var userSource = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(userSource, UserSource);

            var workspaceState = new WorkspaceState();
            var project = workspaceState.AddProject(projPath);
            project.AddFileFromDisk(userSource);
            workspaceState.RegisterFile(userSource, project);

            var server = new LspServer(new DocumentContentService(), workspaceState);

            // A build writes the generated part and the watcher reports a Created event.
            var gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen");
            Directory.CreateDirectory(gsgenDir);
            var generatedPath = Path.Combine(gsgenDir, "Foo.g.gs");
            File.WriteAllText(generatedPath, GeneratedSource);

            var request = new DidChangeWatchedFilesParams
            {
                Changes = new List<FileEvent>
                {
                    new FileEvent { Uri = DocumentUri.FromFileSystemPath(generatedPath), Type = FileChangeType.Created },
                },
            };

            var exception = await Record.ExceptionAsync(() => server.DidChangeWatchedFilesAsync(request));
            Assert.Null(exception);

            // The generated part is now part of the owning project and its member resolves.
            Assert.True(project.ContainsFile(generatedPath));
            var compilation = project.GetCompilation();
            var diagnostics = compilation.GlobalScope.Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList();
            Assert.DoesNotContain(diagnostics, d => d.IsError);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public async Task DidChangeWatchedFiles_DeletedGeneratedPart_RemovesFromProject()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "gsharp-gsgen-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(tempDir);
            var projPath = Path.Combine(tempDir, "Sample.gsproj");
            File.WriteAllText(projPath, "<Project Sdk=\"Gsharp.NET.Sdk\"></Project>");

            var gsgenDir = Path.Combine(tempDir, "obj", "Debug", "net10.0", "gsgen");
            Directory.CreateDirectory(gsgenDir);
            var generatedPath = Path.Combine(gsgenDir, "Foo.g.gs");
            File.WriteAllText(generatedPath, GeneratedSource);

            var workspaceState = new WorkspaceState();
            var project = workspaceState.AddProject(projPath);
            project.AddFileFromDisk(generatedPath);
            workspaceState.RegisterFile(generatedPath, project);

            var server = new LspServer(new DocumentContentService(), workspaceState);

            var request = new DidChangeWatchedFilesParams
            {
                Changes = new List<FileEvent>
                {
                    new FileEvent { Uri = DocumentUri.FromFileSystemPath(generatedPath), Type = FileChangeType.Deleted },
                },
            };

            var exception = await Record.ExceptionAsync(() => server.DidChangeWatchedFilesAsync(request));
            Assert.Null(exception);
            Assert.False(project.ContainsFile(generatedPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }
}
