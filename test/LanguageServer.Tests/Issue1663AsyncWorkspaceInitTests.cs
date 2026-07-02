// <copyright file="Issue1663AsyncWorkspaceInitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #1663: workspace discovery/parsing must not run inline in the "initialize" request —
/// it should happen in the background after "initialized" so the handshake returns promptly and
/// racing requests degrade gracefully instead of crashing or blocking.
/// </summary>
public class Issue1663AsyncWorkspaceInitTests
{
    [Fact]
    public async Task InitializeAsync_DoesNotSynchronouslyLoadWorkspaceProjects()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);

            await server.InitializeAsync(new InitializeParams { RootPath = rootDir });

            // The "initialize" response must return before any project discovery/parsing runs.
            Assert.Empty(workspace.Projects);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    [Fact]
    public async Task Initialized_LoadsWorkspaceProjectsInBackground()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);

            await server.InitializeAsync(new InitializeParams { RootPath = rootDir });
            using var doc = JsonDocument.Parse("{}");
            server.Initialized(doc.RootElement.Clone());

            await WaitForAsync(() => workspace.Projects.Count > 0);

            var project = Assert.Single(workspace.Projects);
            Assert.Equal("Demo", project.AssemblyName);
            var compilation = project.GetCompilation();
            Assert.NotNull(compilation.BoundProgram);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    [Fact]
    public async Task RequestRacingBackgroundLoad_ReturnsEmptyInsteadOfCrashing()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();

            // Simulate a request landing before background discovery has registered any files:
            // GetProjectForFile must return null (handled gracefully by callers) rather than throw.
            var project = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"));
            Assert.Null(project);

            WorkspaceInitializer.Initialize(workspace, rootDir);

            var loaded = workspace.GetProjectForFile(Path.Combine(rootDir, "Demo", "Foo.gs"));
            Assert.NotNull(loaded);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    /// <summary>
    /// Issue #1786 follow-up (B1): the background workspace load must never clobber a client's
    /// open buffer with stale disk text, no matter how didOpen/didChange interleaves with
    /// discovery reaching that file. Runs the real "initialized" background-load path
    /// concurrently with didOpen/didChange on the same file, many times, to flush out both
    /// documented races (client edits before discovery registers the project; client edits
    /// after discovery registers the project but before it visits the file).
    /// </summary>
    [Fact]
    public async Task BackgroundLoadRacingDidOpen_ClientBufferAlwaysWinsOverDisk()
    {
        const string diskText = "func foo() {\n  var x = 1\n}\n";
        const string bufferText = "func foo() {\n  var x = 2 // edited by client\n}\n";

        for (var iteration = 0; iteration < 25; iteration++)
        {
            var rootDir = CreateSampleWorkspace(diskText);
            try
            {
                var workspace = new WorkspaceState();
                var server = new LspServer(new DocumentContentService(), workspace);
                var filePath = Path.Combine(rootDir, "Demo", "Foo.gs");
                var uri = DocumentUri.FromFileSystemPath(filePath);

                await server.InitializeAsync(new InitializeParams { RootPath = rootDir });

                // Kick off the real background load and, concurrently, hammer didOpen/didChange
                // for the same file with different text than what's on disk.
                using var doc = JsonDocument.Parse("{}");
                var initializedTask = Task.Run(() => server.Initialized(doc.RootElement.Clone()));
                var editTask = Task.Run(async () =>
                {
                    await server.DidOpenAsync(new DidOpenTextDocumentParams
                    {
                        TextDocument = new TextDocumentItem { Uri = uri, Text = bufferText },
                    });
                    for (var i = 0; i < 10; i++)
                    {
                        await server.DidChangeAsync(new DidChangeTextDocumentParams
                        {
                            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
                            ContentChanges = new List<TextDocumentContentChangeEvent> { new TextDocumentContentChangeEvent { Text = bufferText } },
                        });
                    }
                });

                await Task.WhenAll(initializedTask, editTask);
                await WaitForAsync(() => workspace.GetProjectForFile(filePath) != null);

                // Give the background load's per-file registration a moment to fully settle
                // (it may still be mid-flight for other files/projects, but this workspace has
                // only one file).
                await WaitForAsync(() =>
                {
                    var proj = workspace.GetProjectForFile(filePath);
                    return proj != null && proj.TryGetSyntaxTree(filePath, out var t) && t.Text.ToString() == bufferText;
                });

                var loadedProject = workspace.GetProjectForFile(filePath);
                Assert.NotNull(loadedProject);
                Assert.True(loadedProject.TryGetSyntaxTree(filePath, out var syntaxTree));
                Assert.Equal(bufferText, syntaxTree.Text.ToString());
            }
            finally
            {
                Directory.Delete(rootDir, recursive: true);
            }
        }
    }

    private static string CreateSampleWorkspace(string sourceText = "func foo() {\n  var x = 1\n}\n")
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsinit_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);

        File.WriteAllText(
            Path.Combine(projDir, "Demo.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

        File.WriteAllText(Path.Combine(projDir, "Foo.gs"), sourceText);

        return rootDir;
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for background workspace load to complete.");
            }

            await Task.Delay(25);
        }
    }
}
