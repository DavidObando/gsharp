// <copyright file="ResxWatchedFileTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

// Issue #2200: saving/creating a .resx within a gsproj's scope should regenerate its
// Resources.Designer.gs codebehind (ADR-0142) via the shared GSharp.Core.Resx generator.
// These tests exercise the behavior through the same public LSP entry point
// (workspace/didChangeWatchedFiles) that the client's file watcher drives.
public class ResxWatchedFileTests
{
    private const string SampleResx = """
        <?xml version="1.0" encoding="utf-8"?>
        <root>
          <data name="Greeting" xml:space="preserve">
            <value>Hello, world!</value>
          </data>
        </root>
        """;

    private static async Task<(string ProjectDir, string ResxPath, string DesignerPath)> RunAsync(FileChangeType changeType, Action<string, string> beforeDispatch = null)
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-resx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var projectPath = Path.Combine(root, "Sample.gsproj");
        File.WriteAllText(projectPath, "<Project><PropertyGroup><RootNamespace>Sample.App</RootNamespace></PropertyGroup></Project>");

        var resxDir = Path.Combine(root, "Properties");
        Directory.CreateDirectory(resxDir);
        var resxPath = Path.Combine(resxDir, "Resources.resx");
        File.WriteAllText(resxPath, SampleResx);

        var workspaceState = new WorkspaceState();
        var project = workspaceState.AddProject(projectPath);
        project.RootNamespace = "Sample.App";

        var server = new LspServer(new DocumentContentService(), workspaceState);

        beforeDispatch?.Invoke(root, resxPath);

        var request = new DidChangeWatchedFilesParams
        {
            Changes = new List<FileEvent>
            {
                new FileEvent { Uri = DocumentUri.FromFileSystemPath(resxPath), Type = changeType },
            },
        };

        await server.DidChangeWatchedFilesAsync(request);

        var designerPath = Path.Combine(resxDir, "Resources.Designer.gs");
        return (root, resxPath, designerPath);
    }

    [Fact]
    public async Task DidChangeWatchedFiles_Created_GeneratesDesignerFile()
    {
        var (root, _, designerPath) = await RunAsync(FileChangeType.Created);

        try
        {
            Assert.True(File.Exists(designerPath));
            var text = File.ReadAllText(designerPath);
            Assert.Contains("Greeting", text);
            Assert.Contains("Sample.App.Properties", text);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DidChangeWatchedFiles_Changed_RegeneratesDesignerFile()
    {
        var (root, resxPath, designerPath) = await RunAsync(FileChangeType.Created);

        try
        {
            Assert.True(File.Exists(designerPath));

            const string updatedResx = """
                <?xml version="1.0" encoding="utf-8"?>
                <root>
                  <data name="Greeting" xml:space="preserve">
                    <value>Hello, world!</value>
                  </data>
                  <data name="Farewell" xml:space="preserve">
                    <value>Goodbye!</value>
                  </data>
                </root>
                """;
            File.WriteAllText(resxPath, updatedResx);

            var workspaceState = new WorkspaceState();
            var project = workspaceState.AddProject(Path.Combine(root, "Sample.gsproj"));
            project.RootNamespace = "Sample.App";
            var server = new LspServer(new DocumentContentService(), workspaceState);

            var request = new DidChangeWatchedFilesParams
            {
                Changes = new List<FileEvent>
                {
                    new FileEvent { Uri = DocumentUri.FromFileSystemPath(resxPath), Type = FileChangeType.Changed },
                },
            };

            await server.DidChangeWatchedFilesAsync(request);

            var text = File.ReadAllText(designerPath);
            Assert.Contains("Greeting", text);
            Assert.Contains("Farewell", text);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DidChangeWatchedFiles_Deleted_LeavesExistingDesignerFileUntouched()
    {
        var (root, _, designerPath) = await RunAsync(FileChangeType.Created);

        try
        {
            Assert.True(File.Exists(designerPath));
            var before = File.ReadAllText(designerPath);

            var workspaceState = new WorkspaceState();
            workspaceState.AddProject(Path.Combine(root, "Sample.gsproj"));
            var server = new LspServer(new DocumentContentService(), workspaceState);

            var request = new DidChangeWatchedFilesParams
            {
                Changes = new List<FileEvent>
                {
                    new FileEvent { Uri = DocumentUri.FromFileSystemPath(Path.Combine(root, "Properties", "Resources.resx")), Type = FileChangeType.Deleted },
                },
            };

            await server.DidChangeWatchedFilesAsync(request);

            Assert.True(File.Exists(designerPath));
            Assert.Equal(before, File.ReadAllText(designerPath));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DidChangeWatchedFiles_MalformedResx_DoesNotThrow()
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-resx-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var projectPath = Path.Combine(root, "Sample.gsproj");
        File.WriteAllText(projectPath, "<Project></Project>");

        var resxPath = Path.Combine(root, "Broken.resx");
        File.WriteAllText(resxPath, "<root><data name=\"X\"><value>unterminated");

        var workspaceState = new WorkspaceState();
        var project = workspaceState.AddProject(projectPath);
        project.RootNamespace = "Sample.App";
        var server = new LspServer(new DocumentContentService(), workspaceState);

        var request = new DidChangeWatchedFilesParams
        {
            Changes = new List<FileEvent>
            {
                new FileEvent { Uri = DocumentUri.FromFileSystemPath(resxPath), Type = FileChangeType.Created },
            },
        };

        try
        {
            // Malformed XML must be swallowed by HandleResxFileChange rather than
            // crashing the didChangeWatchedFiles handler for the whole batch.
            var exception = await Record.ExceptionAsync(() => server.DidChangeWatchedFilesAsync(request));
            Assert.Null(exception);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
